import java.awt.image.BufferedImage;
import java.io.BufferedReader;
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.cos.COSName;
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

/** Edits only uniquely matched, embedded-font single-Tj source bullets. */
public final class PdfSourceRewrite {
  private static final float PAGE_TOLERANCE_PT = 0.5f;
  private static final float WIDTH_TOLERANCE_PT = 0.01f;
  // Includes the measured Noto Sans descender/antialias fringe beyond PDF.js item bounds.
  private static final float PIXEL_MASK_PADDING_PT = 2.5f;
  private static final int MAX_BYTES = 5 * 1024 * 1024;
  private static final int MAX_EDITS = 80;
  private static final int MAX_PAGES = 8;

  private record Edit(String anchorId, int pageNumber, String sourceText, String replacementText, String expectedFamily,
                      float left, float top, float right, float bottom) {}
  private static final class Scope { int showOperators; boolean unsupportedShow; }
  private record Target(int stringIndex, COSString source, PDFont font, float fontSize, Scope scope) {}
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
        if (fields.length != 9 || edits.size() >= MAX_EDITS) throw new IllegalArgumentException("The PDF source edit manifest is invalid or too large.");
        int pageNumber = Integer.parseInt(fields[1]);
        if (pageNumber < 1 || pageNumber > MAX_PAGES) throw new IllegalArgumentException("The PDF edit targets a page outside the supported source profile.");
        edits.add(new Edit(decode(fields[0]), pageNumber, decode(fields[2]), decode(fields[3]), decode(fields[4]),
            Float.parseFloat(fields[5]), Float.parseFloat(fields[6]), Float.parseFloat(fields[7]), Float.parseFloat(fields[8])));
      }
    }
    return edits;
  }

  private static String canonicalFont(String name) {
    String value = name.replaceFirst("^[A-Z]{6}\\+", "").replaceAll("(?i)[-_](regular|bold|italic|oblique|medium|light|book|roman|semibold|demi|black)(?:[-_]\\d+)?", "").replaceAll("[-_]\\d+$", "");
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

  private static List<Target> findTargets(PDPage page, List<Object> tokens, Edit edit) throws Exception {
    List<Target> matches = new ArrayList<>();
    COSName activeFontName = null;
    float activeFontSize = 0;
    Scope scope = null;
    PDResources resources = page.getResources();
    for (int index = 0; index < tokens.size(); index++) {
      Object token = tokens.get(index);
      if (!(token instanceof Operator operator)) continue;
      String name = operator.getName();
      if ("BT".equals(name)) { scope = new Scope(); continue; }
      if ("ET".equals(name)) { scope = null; continue; }
      if ("Tf".equals(name) && index >= 2 && tokens.get(index - 2) instanceof COSName resource && tokens.get(index - 1) instanceof COSNumber size) {
        activeFontName = resource; activeFontSize = size.floatValue(); continue;
      }
      if (scope == null) continue;
      if ("Tj".equals(name)) {
        scope.showOperators++;
        if (index < 1 || !(tokens.get(index - 1) instanceof COSString source) || activeFontName == null) continue;
        PDFont font = resources.getFont(activeFontName);
        try {
          byte[] expected = font.encode(edit.sourceText());
          if (java.util.Arrays.equals(source.getBytes(), expected)) matches.add(new Target(index - 1, source, font, activeFontSize, scope));
        } catch (IllegalArgumentException | java.io.IOException ignored) {
          // A font that cannot encode the source text cannot be an editable match.
        }
      } else if ("TJ".equals(name) || "'".equals(name) || "\"".equals(name)) {
        scope.showOperators++; scope.unsupportedShow = true;
      }
    }
    return matches;
  }

  private static void applyEdit(PDPage page, List<Object> tokens, Edit edit) throws Exception {
    List<Target> matches = findTargets(page, tokens, edit);
    if (matches.size() != 1) throw new IllegalArgumentException("A résumé bullet does not map to one unique PDF text operator. Remove duplicate or split text, or upload an editable DOCX.");
    Target target = matches.get(0);
    if (target.scope() == null || target.scope().showOperators != 1 || target.scope().unsupportedShow)
      throw new IllegalArgumentException("The résumé bullet is split across PDF text operators and cannot be edited without changing its layout.");
    PDFont font = target.font();
    if (!font.isEmbedded() || font instanceof PDType3Font || font.isStandard14())
      throw new IllegalArgumentException("The source font for an edited résumé bullet is not embedded as a supported outline font. Embed that font or upload an editable DOCX; no substitute font will be used.");
    if (!canonicalFont(font.getName()).equals(canonicalFont(edit.expectedFamily())))
      throw new IllegalArgumentException("The PDF source font changed after inspection. Re-upload the original PDF and confirm its current text before drafting.");
    if (!(edit.left() >= 0 && edit.top() >= 0 && edit.right() > edit.left() && edit.bottom() > edit.top()))
      throw new IllegalArgumentException("The résumé bullet has invalid source geometry and cannot be edited safely.");
    byte[] encoded = font.encode(edit.replacementText());
    float beforeWidth = font.getStringWidth(edit.sourceText()) / 1000f * target.fontSize();
    float afterWidth = font.getStringWidth(edit.replacementText()) / 1000f * target.fontSize();
    float sourceBoxWidth = edit.right() - edit.left();
    if (afterWidth > beforeWidth + WIDTH_TOLERANCE_PT || afterWidth > sourceBoxWidth + PAGE_TOLERANCE_PT)
      throw new IllegalArgumentException("LAYOUT_FIT anchorId=" + edit.anchorId() + " page=" + edit.pageNumber() + " reason=width");
    tokens.set(target.stringIndex(), new COSString(encoded));
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
    for (Object token : parse(page)) {
      if (!(token instanceof Operator operator)) continue;
      String name = operator.getName();
      if ("Do".equals(name) || "BI".equals(name)) throw new IllegalArgumentException("This PDF contains an image or Form XObject. The supported profile edits embedded text only; upload an editable DOCX to preserve this layout.");
      if ("W".equals(name) || "W*".equals(name) || "BDC".equals(name) || "BMC".equals(name) || "DP".equals(name) || "MP".equals(name))
        throw new IllegalArgumentException("This PDF uses clipping or marked-content operators outside the supported source profile. Upload an editable DOCX.");
      if (java.util.Set.of("m", "l", "c", "v", "y", "h", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n").contains(name) && ++vectorOperations > 0)
        throw new IllegalArgumentException("This PDF contains vector artwork or outlined text outside the supported text-only profile. Upload an editable DOCX.");
      if ("sh".equals(name)) throw new IllegalArgumentException("This PDF contains a shading pattern outside the supported text-only profile. Upload an editable DOCX.");
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length == 1 && "--version".equals(args[0])) {
      System.out.println("pdfbox=" + Version.getVersion() + "\tjava=" + Runtime.version());
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
      for (int pageIndex = 0; pageIndex < document.getNumberOfPages(); pageIndex++) {
        int pageNumber = pageIndex + 1;
        PDPage page = document.getPage(pageIndex);
        rejectUnsupportedOperations(page);
        pageWidths.add(page.getCropBox().getWidth()); pageHeights.add(page.getCropBox().getHeight());
        before144.add(render(document, pageIndex, 144)); before300.add(render(document, pageIndex, 300));
        List<Edit> pageEdits = edits.stream().filter(edit -> edit.pageNumber() == pageNumber).toList();
        if (!pageEdits.isEmpty()) {
          List<Object> tokens = parse(page);
          for (Edit edit : pageEdits) applyEdit(page, tokens, edit);
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
