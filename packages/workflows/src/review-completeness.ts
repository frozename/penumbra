export type ReviewSnapshot = {
  outcome?: string;
  failed_personas?: string[];
  completed_personas?: string[];
};

export function isReviewComplete(review: ReviewSnapshot | null | undefined): boolean {
  if (!review) return false;
  return review.outcome !== "failed" && (review.failed_personas?.length ?? 0) === 0;
}

export function isReviewClean(opts: {
  green: boolean;
  highCount: number;
  fixRejected: boolean;
  review: ReviewSnapshot | null | undefined;
}): boolean {
  const { green, highCount, fixRejected, review } = opts;
  const reviewPersonas = Array.isArray(review?.completed_personas)
    ? review.completed_personas.length
    : 0;
  const reviewRan = reviewPersonas > 0;
  const reviewComplete = isReviewComplete(review);
  return green && highCount === 0 && !fixRejected && reviewRan && reviewComplete;
}
