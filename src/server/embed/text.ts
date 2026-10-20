// What an embedding model sees for one tweet.

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|\bt\.co\/\S*/giu
// "@a @b actual reply" and "RT @a: ..." prefixes carry no topic.
const LEADING_RE = /^(?:\s*(?:RT\s+)?@\w+:?)+/u
// X substitutes this token for a "Learn more" link in placeholder posts.
const LEARN_MORE_RE = /\{learnmore\}/giu
const ENTITY_RE = /&(amp|lt|gt|quot|apos|nbsp|#39);/gu
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
}
const MAX_TEXT_CHARS = 1000

/** Tweet text without URLs, leading @-chains or X placeholders; entities decoded. */
export function cleanTweetText(text: string): string {
  const s = text
    .replace(URL_RE, ' ')
    .replace(LEADING_RE, ' ')
    .replace(LEARN_MORE_RE, ' ')
    .replace(ENTITY_RE, (_, e: string) => ENTITIES[e] ?? ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return /[\p{L}\p{N}]/u.test(s) ? s.slice(0, MAX_TEXT_CHARS) : ''
}

/**
 * Embedding input: cleaned text plus one `Image: <caption>` line per image
 * caption. Empty when there is nothing to embed.
 */
export function embeddingInput(
  text: string,
  captions: readonly string[] = []
): string {
  const parts = [
    cleanTweetText(text),
    ...captions.filter(Boolean).map((c) => `Image: ${c}`)
  ]
  return parts.filter(Boolean).join('\n')
}
