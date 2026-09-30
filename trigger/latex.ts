import { task } from "@trigger.dev/sdk";
import { fitResume } from "../src/lib/latex-compiler";
import { bytesHash } from "../src/lib/resume-artifacts";
import { latexFixture } from "../src/lib/latex-fixture";

// Manual deployment smoke test: synthetic data only, no stored profiles,
// provider calls, email, browser sessions or employer submissions.
export const verifyLatexRuntime = task({
  id: "verify-latex-runtime",
  retry: { maxAttempts: 1 },
  maxDuration: 120,
  run: async (payload: Record<string, never>) => {
    if (Object.keys(payload).length) throw new Error("The runtime check accepts no input.");
    const { profile, document } = latexFixture();
    const fitted = await fitResume(profile, document);
    return { compiler: "tectonic-0.17.0", pages: 1, bytes: fitted.pdf.length, sha256: bytesHash(fitted.pdf) };
  },
});
