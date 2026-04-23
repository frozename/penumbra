const TAG_RE = /<private>[\s\S]*?<\/private>/g;

export function stripPrivacyTags(text: string): string {
  return text.replace(TAG_RE, '');
}
