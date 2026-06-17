export function isReviewComplete(
  review: { outcome?: string; failed_personas?: string[] } | null | undefined,
): boolean {
  if (!review) return false;
  return review.outcome !== "failed" && (review.failed_personas?.length || 0) === 0;
}

export function isReviewClean(opts: {
  green: boolean;
  highCount: number;
  fixRejected: boolean;
  review: any;
}): boolean {
  const { green, highCount, fixRejected, review } = opts;
  const reviewPersonas =
    review && Array.isArray(review.completed_personas) ? review.completed_personas.length : 0;
  const reviewRan = reviewPersonas > 0;
  const reviewComplete = isReviewComplete(review);
  return green && highCount === 0 && !fixRejected && reviewRan && reviewComplete;
}
