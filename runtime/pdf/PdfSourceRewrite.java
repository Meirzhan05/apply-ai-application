import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSFloat;
import org.apache.pdfbox.cos.COSNumber;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDResources;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.common.PDStream;
import org.apache.pdfbox.pdmodel.font.PDFont;
import org.apache.pdfbox.pdmodel.font.PDType3Font;
import org.apache.pdfbox.pdfparser.PDFStreamParser;
import org.apache.pdfbox.pdfwriter.ContentStreamWriter;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.util.Version;

/** Edits uniquely mapped show-text operators in embedded-font source bullets. */
public final class PdfSourceRewrite {
  private static final float PAGE_TOLERANCE_PT = 0.5f;
  private static final float WIDTH_TOLERANCE_PT = 0.01f;
  // Includes the measured Noto Sans descender/antialias fringe beyond PDF.js item bounds.
  private static final float PIXEL_MASK_PADDING_PT = 2.5f;
  private static final int MAX_BYTES = 5 * 1024 * 1024;
  private static final int MAX_EDITS = 80;
  private static final int MAX_PAGES = 8;

  private record Edit(String anchorId, int pageNumber, int showOperatorIndex, String sourceText, String operatorText, String replacementText, String expectedFamily,
                      float left, float top, float right, float bottom) {}
  private record TextState(COSName fontName, float fontSize, float characterSpacing, float wordSpacing, float horizontalScaling) {}
  private static final class Scope { int showOperators; boolean unsupportedShow; }
  private record Target(int tokenIndex, int operatorTokenIndex, String operatorName, COSBase source, PDFont font, float fontSize,
                        float characterSpacing, float wordSpacing, float horizontalScaling, Scope scope) {}
  private record SourceTextTarget(COSBase source, PDFont font) {}
  private record Replacement(COSArray operands, float naturalAdvanceUnits) {}
  private record Box(int pageNumber, float left, float top, float right, float bottom) {}

  private static String decode(String value) {
    return new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
  }

  private static List<Edit> readEdits(Path file) throws Exception {
    List<Edit> edits = new ArrayList<>();
    try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.isBlank()) continue;
        String[] fields = line.split("\\t", -1);
        if (fields.length != 11 || edits.size() >= MAX_EDITS) throw new IllegalArgumentException("The PDF source edit manifest is invalid or too large.");
        int pageNumber = Integer.parseInt(fields[1]);
        if (pageNumber < 1 || pageNumber > MAX_PAGES) throw new IllegalArgumentException("The PDF edit targets a page outside the supported source profile.");
        int showOperatorIndex = Integer.parseInt(fields[2]);
        if (showOperatorIndex < 0 || showOperatorIndex > 20_000) throw new IllegalArgumentException("The PDF edit has an invalid source operator mapping.");
        edits.add(new Edit(decode(fields[0]), pageNumber, showOperatorIndex, decode(fields[3]), decode(fields[4]), decode(fields[5]), decode(fields[6]),
            Float.parseFloat(fields[7]), Float.parseFloat(fields[8]), Float.parseFloat(fields[9]), Float.parseFloat(fields[10])));
      }
    }
    return edits;
  }

  private static String canonicalFont(String name) {
    // PDFBox includes the embedded subset's CID encoding in getName(), while
    // PDF.js reports the same source family without that transport suffix.
    String value = name.replaceFirst("^[A-Z]{6}\\+", "").replaceAll("(?i)-Identity-H$", "")
      .replaceAll("(?i)[-_](regular|bold|italic|oblique|medium|light|book|roman|semibold|demi|black)(?:[-_]\\d+)?", "")
      .replaceAll("[-_]\\d+$", "");
    return value.replaceAll("[^A-Za-z0-9]", "").toLowerCase(Locale.ROOT);
  }

  private static void assertSupported(PDDocument document) throws Exception {
    if (document.isEncrypted()) throw new IllegalArgumentException("This PDF is encrypted. Remove its password and upload an unlocked PDF or editable DOCX.");
    if (document.getNumberOfPages() < 1 || document.getNumberOfPages() > MAX_PAGES) throw new IllegalArgumentException("This PDF exceeds the bounded eight-page source-preserving profile; no pages were removed.");
    if (!document.getSignatureDictionaries().isEmpty() || !document.getSignatureFields().isEmpty()) throw new IllegalArgumentException("This PDF contains a digital signature. Remove the signature before requesting edits.");
    if (document.getDocumentCatalog().getAcroForm() != null) throw new IllegalArgumentException("This PDF contains interactive form fields outside the supported text-only profile.");
    for (PDPage page : document.getPages()) {
      if (page.getRotation() != 0) throw new IllegalArgumentException("A PDF page is rotated. Save the résumé pages upright or upload an editable DOCX.");
      PDRectangle media = page.getMediaBox();
      PDRectangle crop = page.getCropBox();
      if (Math.abs(media.getLowerLeftX() - crop.getLowerLeftX()) > PAGE_TOLERANCE_PT || Math.abs(media.getLowerLeftY() - crop.getLowerLeftY()) > PAGE_TOLERANCE_PT ||
          Math.abs(media.getWidth() - crop.getWidth()) > PAGE_TOLERANCE_PT || Math.abs(media.getHeight() - crop.getHeight()) > PAGE_TOLERANCE_PT)
        throw new IllegalArgumentException("This PDF uses a cropped page box outside the supported source profile. Save standard page boxes or upload an editable DOCX.");
      if (crop.getWidth() > 900 || crop.getHeight() > 1100 || (double) crop.getWidth() * crop.getHeight() > 600_000)
        throw new IllegalArgumentException("A PDF page exceeds the bounded page-size profile. Save standard résumé page dimensions or upload an editable DOCX.");
    }
  }

  private static List<Object> parse(PDPage page) throws Exception { return new PDFStreamParser(page).parse(); }

  private static void saveTokens(PDDocument document, PDPage page, List<Object> tokens) throws Exception {
    PDStream stream = new PDStream(document);
    try (OutputStream output = stream.createOutputStream(COSName.FLATE_DECODE)) { new ContentStreamWriter(output).writeTokens(tokens); }
    page.setContents(stream);
  }

  private static String decodeString(PDFont font, COSString string) throws Exception {
    StringBuilder result = new StringBuilder();
    ByteArrayInputStream input = new ByteArrayInputStream(string.getBytes());
    while (input.available() > 0) {
      int code = font.readCode(input);
      String unicode = font.toUnicode(code);
      if (unicode == null) throw new IllegalArgumentException("The PDF source font has no Unicode mapping for a targeted glyph.");
      result.append(unicode);
    }
    return result.toString();
  }

  private static String decodeShowText(PDFont font, COSBase source) throws Exception {
    if (source instanceof COSString string) return decodeString(font, string);
    if (source instanceof org.apache.pdfbox.cos.COSArray array) {
      StringBuilder result = new StringBuilder();
      for (COSBase item : array) if (item instanceof COSString string) result.append(decodeString(font, string));
      return result.toString();
    }
    throw new IllegalArgumentException("The targeted PDF text-show operator has an unsupported operand.");
  }

  private static float stringWidthUnits(PDFont font, COSString string) throws Exception {
    float width = 0;
    ByteArrayInputStream input = new ByteArrayInputStream(string.getBytes());
    while (input.available() > 0) width += font.getWidth(font.readCode(input));
    return width;
  }

  private static float showAdvanceUnits(PDFont font, COSBase source) throws Exception {
    if (source instanceof COSString string) return stringWidthUnits(font, string);
    if (source instanceof org.apache.pdfbox.cos.COSArray array) {
      float advance = 0;
      for (COSBase item : array) {
        if (item instanceof COSString string) advance += stringWidthUnits(font, string);
        else if (item instanceof COSNumber adjustment) advance -= adjustment.floatValue();
        else throw new IllegalArgumentException("The targeted PDF text-show array contains an unsupported operand.");
      }
      return advance;
    }
    throw new IllegalArgumentException("The targeted PDF text-show operator has an unsupported operand.");
  }

  private record SourceGlyph(String unicode, byte[] bytes) {}

  private static String comparableGlyphText(String text) {
    return text.replace("\uFB00", "ff").replace("\uFB01", "fi").replace("\uFB02", "fl")
      .replace("\uFB03", "ffi").replace("\uFB04", "ffl").replace("\uFB05", "st").replace("\uFB06", "st");
  }

  private static List<SourceGlyph> sourceGlyphs(PDFont font, COSBase source) throws Exception {
    List<COSString> strings = new ArrayList<>();
    if (source instanceof COSString string) strings.add(string);
    else if (source instanceof COSArray array) for (COSBase item : array) if (item instanceof COSString string) strings.add(string);
    List<SourceGlyph> glyphs = new ArrayList<>();
    for (COSString string : strings) {
      byte[] bytes = string.getBytes();
      ByteArrayInputStream input = new ByteArrayInputStream(bytes);
      while (input.available() > 0) {
        int start = bytes.length - input.available();
        int code = font.readCode(input);
        int end = bytes.length - input.available();
        String unicode = font.toUnicode(code);
        if (unicode != null && end > start) glyphs.add(new SourceGlyph(comparableGlyphText(unicode),
          java.util.Arrays.copyOfRange(bytes, start, end)));
      }
    }
    return glyphs;
  }

  private static Map<COSBase, List<SourceGlyph>> collectSourceGlyphPools(PDDocument document) throws Exception {
    Map<COSBase, List<SourceGlyph>> pools = new IdentityHashMap<>();
    for (PDPage page : document.getPages()) {
      PDResources resources = page.getResources();
      List<Object> tokens = parse(page);
      PDFont activeFont = null;
      List<PDFont> fontStack = new ArrayList<>();
      for (int index = 0; index < tokens.size(); index++) {
        Object token = tokens.get(index);
        if (!(token instanceof Operator operator)) continue;
        String name = operator.getName();
        if ("q".equals(name)) { fontStack.add(activeFont); continue; }
        if ("Q".equals(name)) { if (!fontStack.isEmpty()) activeFont = fontStack.remove(fontStack.size() - 1); continue; }
        if ("Tf".equals(name) && index >= 2 && tokens.get(index - 2) instanceof COSName resource) {
          activeFont = resources.getFont(resource);
          continue;
        }
        if (!("Tj".equals(name) || "TJ".equals(name) || "'".equals(name) || "\"".equals(name)) || index < 1 || activeFont == null) continue;
        if (!(tokens.get(index - 1) instanceof COSBase source) || (!(source instanceof COSString) && !(source instanceof COSArray))) continue;
        pools.computeIfAbsent(activeFont.getCOSObject(), ignored -> new ArrayList<>()).addAll(sourceGlyphs(activeFont, source));
      }
    }
    return pools;
  }

  private static byte[] encodeFromSourceGlyphs(PDFont font, String text, COSBase source, List<SourceGlyph> fontGlyphs) throws Exception {
    List<SourceGlyph> glyphs = sourceGlyphs(font, source);
    for (SourceGlyph glyph : fontGlyphs) if (!glyphs.contains(glyph)) glyphs.add(glyph);
    String comparableText = comparableGlyphText(text);
    java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
    for (int offset = 0; offset < comparableText.length();) {
      SourceGlyph best = null;
      for (SourceGlyph glyph : glyphs) {
        if (glyph.unicode().isEmpty() || !comparableText.startsWith(glyph.unicode(), offset)) continue;
        if (best == null || glyph.unicode().length() > best.unicode().length()) best = glyph;
      }
      if (best == null) {
        int codePoint = comparableText.codePointAt(offset);
        throw new IllegalArgumentException(String.format(Locale.ROOT, "No glyph for U+%04X in the original embedded source font.", codePoint));
      }
      output.write(best.bytes());
      offset += best.unicode().length();
    }
    return output.toByteArray();
  }

  @FunctionalInterface private interface TextEncoder { byte[] encode(String text) throws Exception; }

  private static byte[] encodeWithSourceFallback(PDFont font, String text, COSBase source, List<SourceGlyph> fontGlyphs, TextEncoder encoder) throws Exception {
    try { return encoder.encode(text); }
    catch (UnsupportedOperationException error) { return encodeFromSourceGlyphs(font, text, source, fontGlyphs); }
  }

  private static Replacement replacementShowText(PDFont font, String replacementText, COSBase source, List<SourceGlyph> fontGlyphs) throws Exception {
    COSArray result = new COSArray();
    float spaceWidth = font.getSpaceWidth();
    if (!(spaceWidth > 0)) throw new IllegalArgumentException("The source font has no measurable word-space advance; no replacement was written.");
    java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("(\\s+|\\S+)").matcher(replacementText);
    float replacementAdvance = 0;
    while (matcher.find()) {
      String run = matcher.group();
      if (run.codePoints().allMatch(Character::isWhitespace)) {
        if (!run.chars().allMatch(ch -> ch == ' ')) throw new IllegalArgumentException("The replacement contains unsupported whitespace for this PDF source font.");
        float adjustment = -spaceWidth * run.length();
        result.add(new org.apache.pdfbox.cos.COSFloat(adjustment));
        replacementAdvance += -adjustment;
      } else {
        byte[] encoded = encodeWithSourceFallback(font, run, source, fontGlyphs, font::encode);
        COSString string = new COSString(encoded);
        result.add(string);
        replacementAdvance += stringWidthUnits(font, string);
      }
    }
    return new Replacement(result, replacementAdvance);
  }

  private static List<Target> findTargets(PDPage page, List<Object> tokens, Edit edit) throws Exception {
    List<Target> matches = new ArrayList<>();
    COSName activeFontName = null;
    float activeFontSize = 0;
    float activeCharacterSpacing = 0;
    float activeWordSpacing = 0;
    float activeHorizontalScaling = 100;
    int showOperatorIndex = 0;
    Scope scope = null;
    List<TextState> graphicsStateStack = new ArrayList<>();
    PDResources resources = page.getResources();
    for (int index = 0; index < tokens.size(); index++) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) continue;
      String name = operator.getName();
      if ("q".equals(name)) {
        graphicsStateStack.add(new TextState(activeFontName, activeFontSize, activeCharacterSpacing, activeWordSpacing, activeHorizontalScaling));
        continue;
      }
      if ("Q".equals(name)) {
        if (!graphicsStateStack.isEmpty()) {
          TextState restored = graphicsStateStack.remove(graphicsStateStack.size() - 1);
          activeFontName = restored.fontName(); activeFontSize = restored.fontSize(); activeCharacterSpacing = restored.characterSpacing();
          activeWordSpacing = restored.wordSpacing(); activeHorizontalScaling = restored.horizontalScaling();
        }
        continue;
      }
      if ("BT".equals(name)) { scope = new Scope(); continue; }
      if ("ET".equals(name)) { scope = null; continue; }
      if ("Tf".equals(name) && index >= 2 && tokens.get(index - 2) instanceof COSName resource && tokens.get(index - 1) instanceof COSNumber size) {
        activeFontName = resource; activeFontSize = size.floatValue(); continue;
      }
      if (("Tc".equals(name) || "Tw".equals(name) || "Tz".equals(name)) && index >= 1 && tokens.get(index - 1) instanceof COSNumber value) {
        if ("Tc".equals(name)) activeCharacterSpacing = value.floatValue();
        else if ("Tw".equals(name)) activeWordSpacing = value.floatValue();
        else activeHorizontalScaling = value.floatValue();
        continue;
      }
      boolean textShow = "Tj".equals(name) || "TJ".equals(name) || "'".equals(name) || "\"".equals(name);
      if (!textShow) continue;
      int ordinal = showOperatorIndex++;
      if (scope != null) scope.showOperators++;
      if (ordinal != edit.showOperatorIndex() || index < 1 || activeFontName == null) continue;
      COSBase source = tokens.get(index - 1) instanceof COSBase base ? base : null;
      if (!(source instanceof COSString) && !(source instanceof org.apache.pdfbox.cos.COSArray)) continue;
      PDFont font = resources.getFont(activeFontName);
      if (decodeShowText(font, source).equals(edit.operatorText()))
        matches.add(new Target(index - 1, index, name, source, font, activeFontSize, activeCharacterSpacing, activeWordSpacing, activeHorizontalScaling, scope));
    }
    return matches;
  }

  private static SourceTextTarget findSourceText(PDDocument document, String text) throws Exception {
    for (PDPage page : document.getPages()) {
      PDResources resources = page.getResources();
      List<Object> tokens = parse(page);
      PDFont activeFont = null;
      for (int index = 0; index < tokens.size(); index++) {
        Object token = tokens.get(index);
        if (!(token instanceof Operator operator)) continue;
        String name = operator.getName();
        if ("Tf".equals(name) && index >= 2 && tokens.get(index - 2) instanceof COSName resource) {
          activeFont = resources.getFont(resource);
          continue;
        }
        if (!("Tj".equals(name) || "TJ".equals(name)) || index < 1 || activeFont == null) continue;
        if (tokens.get(index - 1) instanceof COSBase source) {
          String decoded = decodeShowText(activeFont, source);
          if (decoded.equals(text) || decoded.endsWith(text)) return new SourceTextTarget(source, activeFont);
        }
      }
    }
    throw new IllegalArgumentException("The source-glyph test text was not found.");
  }

  private static void selfTestSourceGlyphFallback(Path sourcePath) throws Exception {
    try (PDDocument document = Loader.loadPDF(sourcePath.toFile())) {
      SourceTextTarget target = findSourceText(document, "Built a search index for 1,200 users.");
      List<SourceGlyph> fontGlyphs = collectSourceGlyphPools(document).get(target.font().getCOSObject());
      if (fontGlyphs == null) throw new IllegalStateException("The synthetic font glyph pool was not collected.");
      byte[] encoded = encodeWithSourceFallback(target.font(), "é", target.source(), fontGlyphs, ignored -> { throw new UnsupportedOperationException(); });
      if (!decodeString(target.font(), new COSString(encoded)).equals("é")) throw new IllegalStateException("The source-glyph fallback did not preserve Unicode text.");
      boolean rejected = false;
      try { encodeWithSourceFallback(target.font(), "🪐", target.source(), fontGlyphs, ignored -> { throw new UnsupportedOperationException(); }); }
      catch (IllegalArgumentException error) { rejected = error.getMessage().contains("No glyph for U+1FA90"); }
      if (!rejected) throw new IllegalStateException("The source-glyph fallback did not reject an ungrounded missing glyph.");
      System.out.println("sourceGlyphFallback=passed");
    }
  }

  private static void applyEdit(PDPage page, List<Object> tokens, Edit edit, Map<COSBase, List<SourceGlyph>> fontGlyphs) throws Exception {
    List<Target> matches = findTargets(page, tokens, edit);
    if (matches.size() != 1) throw new IllegalArgumentException("A résumé bullet does not map to one unique PDF text operator. Remove duplicate or split text, or upload an editable DOCX.");
    Target target = matches.get(0);
    if (target.scope() == null) throw new IllegalArgumentException("The source text operator is outside a supported PDF text object.");
    PDFont font = target.font();
    if (!font.isEmbedded() || font instanceof PDType3Font || font.isStandard14())
      throw new IllegalArgumentException("The source font for an edited résumé bullet is not embedded as a supported outline font. Embed that font or upload an editable DOCX; no substitute font will be used.");
    if (Math.abs(target.characterSpacing()) > 0.001f || Math.abs(target.wordSpacing()) > 0.001f || Math.abs(target.horizontalScaling() - 100) > 0.001f)
      throw new IllegalArgumentException("The source bullet uses character, word, or horizontal text spacing that cannot be safely preserved by this PDF editor.");
    if (!canonicalFont(font.getName()).equals(canonicalFont(edit.expectedFamily())))
      throw new IllegalArgumentException("The PDF source font changed after inspection. Re-upload the original PDF and confirm its current text before drafting.");
    if (!(edit.left() >= 0 && edit.top() >= 0 && edit.right() > edit.left() && edit.bottom() > edit.top()))
      throw new IllegalArgumentException("The résumé bullet has invalid source geometry and cannot be edited safely.");
    float originalAdvanceUnits = showAdvanceUnits(font, target.source());
    float beforeWidth = originalAdvanceUnits / 1000f * target.fontSize();
    List<SourceGlyph> glyphPool = fontGlyphs.get(font.getCOSObject());
    if (glyphPool == null) throw new IllegalArgumentException("The original PDF source font has no collected glyph mappings.");
    Replacement replacement = replacementShowText(font, edit.replacementText(), target.source(), glyphPool);
    float afterWidth = replacement.naturalAdvanceUnits() / 1000f * target.fontSize();
    float sourceBoxWidth = edit.right() - edit.left();
    if (afterWidth > beforeWidth + WIDTH_TOLERANCE_PT || afterWidth > sourceBoxWidth + PAGE_TOLERANCE_PT)
      throw new IllegalArgumentException("LAYOUT_FIT anchorId=" + edit.anchorId() + " page=" + edit.pageNumber() + " reason=width");
    float compensation = replacement.naturalAdvanceUnits() - originalAdvanceUnits;
    if (Math.abs(compensation) > 0.001f) replacement.operands().add(new COSFloat(compensation));
    tokens.set(target.tokenIndex(), replacement.operands());
    if ("Tj".equals(target.operatorName())) tokens.set(target.operatorTokenIndex(), Operator.getOperator("TJ"));
    else if (!"TJ".equals(target.operatorName())) throw new IllegalArgumentException("The targeted quote-style PDF text operator cannot be rewritten without changing its line positioning.");
  }

  private static String extracted(PDDocument document) throws Exception {
    PDFTextStripper stripper = new PDFTextStripper(); stripper.setSortByPosition(true);
    return stripper.getText(document).replace('\u00a0', ' ').replaceAll("\\s+", " ").trim();
  }

  private static BufferedImage render(PDDocument document, int pageIndex, int dpi) throws Exception { return new PDFRenderer(document).renderImageWithDPI(pageIndex, dpi); }

  private static double outsideDifference(BufferedImage before, BufferedImage after, List<Box> boxes, int dpi) {
    if (before.getWidth() != after.getWidth() || before.getHeight() != after.getHeight()) throw new IllegalArgumentException("The PDF renderer changed page dimensions after editing.");
    int width = before.getWidth(), height = before.getHeight(), changed = 0, outside = 0;
    float scale = dpi / 72f;
    for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
      boolean masked = false;
      float xPt = x / scale, yPt = y / scale;
      for (Box box : boxes) if (xPt >= box.left() && xPt <= box.right() && yPt >= box.top() && yPt <= box.bottom()) { masked = true; break; }
      if (!masked) { outside++; if (before.getRGB(x, y) != after.getRGB(x, y)) changed++; }
    }
    return outside == 0 ? 0 : (double) changed / outside;
  }

  private static int countOccurrences(String text, String needle) {
    int count = 0, cursor = 0;
    while ((cursor = text.indexOf(needle, cursor)) >= 0) { count++; cursor += Math.max(1, needle.length()); }
    return count;
  }

  private static void rejectUnsupportedOperations(PDPage page) throws Exception {
    int vectorOperations = 0;
    int acceptedDividers = 0;
    float pathX = 0, pathY = 0;
    List<Object> tokens = parse(page);
    for (int tokenIndex = 0; tokenIndex < tokens.size(); tokenIndex++) {
      Object token = tokens.get(tokenIndex);
      if (!(token instanceof Operator operator)) continue;
      String name = operator.getName();
      if ((vectorOperations == 1 && !"l".equals(name)) || (vectorOperations == 2 && !"S".equals(name)))
        throw new IllegalArgumentException("This PDF contains a non-linear or compound vector path outside the supported source profile.");
      if ("Do".equals(name) || "BI".equals(name)) throw new IllegalArgumentException("This PDF contains an image or Form XObject. The supported profile edits embedded text only; upload an editable DOCX to preserve this layout.");
      if ("W".equals(name) || "W*".equals(name) || "BDC".equals(name) || "BMC".equals(name) || "DP".equals(name) || "MP".equals(name))
        throw new IllegalArgumentException("This PDF uses clipping or marked-content operators outside the supported source profile. Upload an editable DOCX.");
      if ("m".equals(name)) {
        if (vectorOperations != 0 || tokenIndex < 2 || !(tokens.get(tokenIndex - 2) instanceof COSNumber x) || !(tokens.get(tokenIndex - 1) instanceof COSNumber y))
          throw new IllegalArgumentException("This PDF contains vector artwork or outlined text outside the supported text-only profile. Upload an editable DOCX.");
        vectorOperations = 1;
        pathX = x.floatValue(); pathY = y.floatValue();
      } else if ("l".equals(name)) {
        if (vectorOperations != 1 || tokenIndex < 2 || !(tokens.get(tokenIndex - 2) instanceof COSNumber x) || !(tokens.get(tokenIndex - 1) instanceof COSNumber y) ||
            Math.abs(y.floatValue() - pathY) > 0.01f || Math.abs(x.floatValue() - pathX) < 1f)
          throw new IllegalArgumentException("This PDF contains vector artwork or outlined text outside the supported text-only profile. Upload an editable DOCX.");
        vectorOperations = 2;
      } else if ("S".equals(name)) {
        if (vectorOperations != 2 || ++acceptedDividers > 16) throw new IllegalArgumentException("This PDF contains vector artwork or outlined text outside the supported text-only profile. Upload an editable DOCX.");
        vectorOperations = 0;
      } else if (java.util.Set.of("c", "v", "y", "h", "re", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n").contains(name))
        throw new IllegalArgumentException("This PDF contains vector artwork or outlined text outside the supported text-only profile. Upload an editable DOCX.");
      if ("sh".equals(name)) throw new IllegalArgumentException("This PDF contains a shading pattern outside the supported text-only profile. Upload an editable DOCX.");
    }
    if (vectorOperations != 0) throw new IllegalArgumentException("This PDF contains an incomplete vector divider path outside the supported source profile.");
  }

  public static void main(String[] args) throws Exception {
    if (args.length == 1 && "--version".equals(args[0])) {
      System.out.println("pdfbox=" + Version.getVersion() + "\tjava=" + Runtime.version());
      return;
    }
    if (args.length == 2 && "--self-test-source-glyph-fallback".equals(args[0])) {
      selfTestSourceGlyphFallback(Path.of(args[1]));
      return;
    }
    if (args.length != 3) throw new IllegalArgumentException("Usage: PdfSourceRewrite <input.pdf> <output.pdf> <edits.tsv>");
    Path sourcePath = Path.of(args[0]); Path outputPath = Path.of(args[1]);
    if (Files.size(sourcePath) < 1 || Files.size(sourcePath) > MAX_BYTES) throw new IllegalArgumentException("The source PDF must be between 1 byte and 5 MB.");
    List<Edit> edits = readEdits(Path.of(args[2]));
    List<Box> boxes = edits.stream().map(edit -> new Box(edit.pageNumber(), edit.left() - PIXEL_MASK_PADDING_PT, edit.top() - PIXEL_MASK_PADDING_PT, edit.right() + PIXEL_MASK_PADDING_PT, edit.bottom() + PIXEL_MASK_PADDING_PT)).toList();
    List<BufferedImage> before144 = new ArrayList<>(); List<BufferedImage> before300 = new ArrayList<>();
    List<Float> pageWidths = new ArrayList<>(); List<Float> pageHeights = new ArrayList<>();
    try (PDDocument document = Loader.loadPDF(sourcePath.toFile())) {
      assertSupported(document);
      Map<COSBase, List<SourceGlyph>> fontGlyphs = collectSourceGlyphPools(document);
      for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex++) {
        int pageNumber = pageIndex + 1;
        PDPage page = document.getPage(pageIndex);
        rejectUnsupportedOperations(page);
        pageWidths.add(page.getCropBox().getWidth()); pageHeights.add(page.getCropBox().getHeight());
        before144.add(render(document, pageIndex, 144)); before300.add(render(document, pageIndex, 300));
        List<Edit> pageEdits = edits.stream().filter(edit -> edit.pageNumber() == pageNumber).toList();
        if (!pageEdits.isEmpty()) {
          List<Object> tokens = parse(page);
          for (Edit edit : pageEdits) applyEdit(page, tokens, edit, fontGlyphs);
          saveTokens(document, page, tokens);
        }
      }
      if (edits.isEmpty()) {
        Files.copy(sourcePath, outputPath, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      } else document.save(outputPath.toFile());
    }
    List<Double> differences144 = new ArrayList<>(); List<Double> differences300 = new ArrayList<>();
    try (PDDocument output = Loader.loadPDF(outputPath.toFile()); PDDocument input = Loader.loadPDF(sourcePath.toFile())) {
      assertSupported(output);
      if (output.getNumberOfPages() != input.getNumberOfPages()) throw new IllegalArgumentException("The PDF rewrite changed the original page count; no content may be added or removed.");
      for (int pageIndex = 0; pageIndex < input.getNumberOfPages(); pageIndex++) {
        PDRectangle before = input.getPage(pageIndex).getCropBox();
        PDRectangle after = output.getPage(pageIndex).getCropBox();
        if (Math.abs(after.getWidth() - before.getWidth()) > PAGE_TOLERANCE_PT || Math.abs(after.getHeight() - before.getHeight()) > PAGE_TOLERANCE_PT ||
            Math.abs(after.getLowerLeftX() - before.getLowerLeftX()) > PAGE_TOLERANCE_PT || Math.abs(after.getLowerLeftY() - before.getLowerLeftY()) > PAGE_TOLERANCE_PT)
          throw new IllegalArgumentException("The PDF rewrite changed page " + (pageIndex + 1) + " dimensions beyond 0.5 pt.");
      }
      String beforeText = extracted(input); String afterText = extracted(output);
      for (Edit edit : edits) {
        if (!afterText.contains(edit.replacementText())) throw new IllegalStateException("The saved PDF does not contain the exact rewritten résumé bullet.");
        if (!edit.sourceText().equals(edit.replacementText()) && !edit.replacementText().contains(edit.sourceText()) && countOccurrences(afterText, edit.sourceText()) >= countOccurrences(beforeText, edit.sourceText()))
          throw new IllegalStateException("The original résumé bullet remains extractable after the PDF rewrite.");
      }
      for (int pageIndex = 0; pageIndex < output.getNumberOfPages(); pageIndex++) {
        int pageNumber = pageIndex + 1;
        rejectUnsupportedOperations(output.getPage(pageIndex));
        List<Box> pageBoxes = boxes.stream().filter(box -> box.pageNumber() == pageNumber).toList();
        double difference144 = outsideDifference(before144.get(pageIndex), render(output, pageIndex, 144), pageBoxes, 144);
        double difference300 = outsideDifference(before300.get(pageIndex), render(output, pageIndex, 300), pageBoxes, 300);
        differences144.add(difference144); differences300.add(difference300);
        if (difference144 != 0 || difference300 != 0) throw new IllegalArgumentException("The PDF render changed page " + (pageIndex + 1) + " pixels outside edited text boxes (144 dpi: " + difference144 + ", 300 dpi: " + difference300 + "). No font substitution or overlay will be used.");
      }
    }
    System.out.printf(Locale.ROOT, "pdfbox=%s\tpages=%d\tpageWidthPt=%.3f\tpageHeightPt=%.3f\toutsideDifferenceAt144Dpi=%.8f\toutsideDifferenceAt300Dpi=%.8f%n",
        Version.getVersion(), pageWidths.size(), pageWidths.get(0), pageHeights.get(0), differences144.stream().mapToDouble(Double::doubleValue).max().orElse(0), differences300.stream().mapToDouble(Double::doubleValue).max().orElse(0));
    for (int pageIndex = 0; pageIndex < pageWidths.size(); pageIndex++) {
      System.out.printf(Locale.ROOT, "page=%d\tpageWidthPt=%.3f\tpageHeightPt=%.3f\toutsideDifferenceAt144Dpi=%.8f\toutsideDifferenceAt300Dpi=%.8f%n",
          pageIndex + 1, pageWidths.get(pageIndex), pageHeights.get(pageIndex), differences144.get(pageIndex), differences300.get(pageIndex));
    }
  }
}
