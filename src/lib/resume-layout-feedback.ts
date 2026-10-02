export interface ResumeLayoutFeedback {
  anchorId: string;
  pageNumber: number;
  regionId: string;
  reason: string;
}

export class ResumeLayoutFeedbackError extends Error {
  constructor(readonly feedback: ResumeLayoutFeedback) {
    super("The edited wording does not fit its original page and layout region.");
    this.name = "ResumeLayoutFeedbackError";
  }
}
