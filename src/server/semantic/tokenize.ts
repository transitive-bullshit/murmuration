import { STOPWORDS } from './stopwords'

// Inserted where we remove content so bigrams never bridge the gap.
const BREAK = ' | '

const URL_RE =
  /\bhttps?:\/\/\S+|\bwww\.\S+|\bt\.co\/\S*|\b[\w-]+(?:\.[\w-]+)+\/\S*/giu
const ENTITY_RE = /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/giu
const MENTION_RE = /(^|[^\p{L}\p{N}_])@[a-z0-9_]+/giu
const HASHTAG_RE = /(^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu
const POSSESSIVE_RE = /(\p{L})['’‘`]s\b/gu
const APOSTROPHE_RE = /['’‘`]/gu
// "soooo" → "so", "yesss" → "yes": collapse runs of 3+ letters to one…
const ELONGATED_RE = /(\p{L})\1{2,}/gu
const HAS_ELONGATION_RE = /(\p{L})\1{2}/u
const WORD_RE = /\p{L}+/gu
// …unless two letters spell a common word: "hellll" → "hell", not "hel",
// and "goooood" → "good", not "god".
const DOUBLED_WORDS: ReadonlySet<string> = new Set([
  'add',
  'agree',
  'all',
  'ball',
  'beer',
  'bill',
  'book',
  'boom',
  'call',
  'cheers',
  'coffee',
  'cook',
  'cool',
  'deep',
  'door',
  'fall',
  'feel',
  'fill',
  'food',
  'free',
  'full',
  'good',
  'hell',
  'keep',
  'kill',
  'look',
  'meet',
  'mood',
  'moon',
  'need',
  'off',
  'pass',
  'poor',
  'pull',
  'see',
  'sleep',
  'small',
  'soon',
  'still',
  'stuff',
  'sweet',
  'tall',
  'three',
  'too',
  'wall',
  'week',
  'well',
  'will',
  'wood',
  'yall',
  'zoom'
])
// Words that describe how an image looks rather than what it's about
// ("a bearded man sits beneath a peach sky"); kept out of caption terms so
// topic labels name subjects, not composition.
const CAPTION_FILLER: ReadonlySet<string> = new Set([
  'appears',
  'background',
  'bearded',
  'beige',
  'beneath',
  'behind',
  'beside',
  'black',
  'blue',
  'bottom',
  'bright',
  'brown',
  'caption',
  'center',
  'close',
  'closeup',
  'colorful',
  'dark',
  'depicting',
  'depicts',
  'displayed',
  'displaying',
  'featuring',
  'foreground',
  'graphic',
  'gray',
  'green',
  'grey',
  'holding',
  'illustration',
  'image',
  'labeled',
  'large',
  'left',
  'light',
  'looking',
  'lying',
  'man',
  'men',
  'middle',
  'near',
  'orange',
  'peach',
  'people',
  'person',
  'photo',
  'photograph',
  'picture',
  'pink',
  'purple',
  'reads',
  'red',
  'right',
  'scene',
  'screen',
  'screenshot',
  'shot',
  'showing',
  'shown',
  'shows',
  'sits',
  'sitting',
  'small',
  'smiling',
  'stand',
  'standing',
  'stands',
  'text',
  'titled',
  'top',
  'visible',
  'wearing',
  'white',
  'woman',
  'women',
  'yellow'
])

function deElongate(word: string): string {
  if (!HAS_ELONGATION_RE.test(word)) return word
  const two = word.replace(ELONGATED_RE, '$1$1')
  return DOUBLED_WORDS.has(two) ? two : word.replace(ELONGATED_RE, '$1')
}

/** An image caption minus its visual filler words, for topic terms. */
export function captionTerms(caption: string): string {
  return caption.replace(WORD_RE, (word) =>
    CAPTION_FILLER.has(word.toLowerCase()) ? BREAK : word
  )
}
const TOKEN_RE = /[\p{L}\p{N}\p{M}]+(?:[-.][\p{L}\p{N}\p{M}]+)*/gu
const GAP_RE = /^\s*$/u

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const DOTTED_KEEP_RE =
  /^[\p{L}\p{N}]+\.(?:ai|io|dev|com|app|sh|so|org|net|py|rs|md|xyz|gg|fm|tv|run|chat|cloud|tech)$/u
// Model / version names such as gpt-4, gpt-3.5, llama-3, covid-19.
const VERSIONED_RE = /^\p{L}[\p{L}\p{N}]*(?:-[\p{L}\p{N}.]+){1,2}$/u
const NUMERIC_RE = /^\p{N}+$/u
const UNIT_RE =
  /^\d+(?:st|nd|rd|th|am|pm|s|k|m|b|h|hr|hrs|min|mins|ms|px|gb|mb|kb|tb|yo|x|yr|yrs|mo|d|w)$/u
const JUNK_RE = /^(?:v\d+|0x[0-9a-f]+|(.)\1+|(?:ha|he|ah|lo|ja)+h?)$/u

function expandToken(token: string): string[] {
  if (!token.includes('-') && !token.includes('.')) return [token]
  if (token.includes('.')) {
    // Fold "next.js" / "node.js" into the common "nextjs" spelling.
    if (/^[\p{L}\p{N}]+\.js$/u.test(token)) return [token.replace('.', '')]
    if (DOTTED_KEEP_RE.test(token)) return [token]
  }
  if (VERSIONED_RE.test(token) && /\d/.test(token) && token.length <= 16)
    return [token]
  return token.split(/[-.]+/)
}

function isKept(token: string): boolean {
  if (token.length < 2 || token.length > 30) return false
  if (NUMERIC_RE.test(token) || UNIT_RE.test(token) || JUNK_RE.test(token))
    return false
  return !STOPWORDS.has(token)
}

/** CJK has no word spaces: index overlapping character bigrams instead. */
function cjkBigrams(token: string): string[] {
  const chars = Array.from(token)
  if (chars.length < 2) return []
  if (chars.length === 2) return [token]
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!)
  return out
}

/** Strip URLs, mentions, HTML entities and normalize case / apostrophes. */
export function cleanText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(URL_RE, BREAK)
    .replace(ENTITY_RE, BREAK)
    .replace(MENTION_RE, `$1${BREAK}`)
    .toLowerCase()
    .replace(/\bc\+\+/gu, 'cpp')
    .replace(/\bc#/gu, 'csharp')
    .replace(HASHTAG_RE, `$1${BREAK}$2${BREAK}`)
    .replace(POSSESSIVE_RE, '$1')
    .replace(APOSTROPHE_RE, '')
    .replace(WORD_RE, deElongate)
}

/**
 * Kept tokens grouped into runs of words that were directly adjacent in the
 * text (only whitespace between them). Dropped words, punctuation, URLs,
 * mentions and hashtags all end a run, so bigrams stay readable.
 */
export function tokenRuns(text: string): string[][] {
  const s = cleanText(text)
  const runs: string[][] = []
  let run: string[] = []
  let lastEnd = 0
  const flush = () => {
    if (run.length) runs.push(run)
    run = []
  }

  for (const match of s.matchAll(TOKEN_RE)) {
    const start = match.index
    if (!GAP_RE.test(s.slice(lastEnd, start))) flush()
    lastEnd = start + match[0].length

    if (CJK_RE.test(match[0])) {
      flush()
      for (const gram of cjkBigrams(match[0])) runs.push([gram])
      continue
    }

    for (const token of expandToken(match[0])) {
      if (isKept(token)) run.push(token)
      else flush()
    }
  }
  flush()
  return runs
}

/** Kept unigram tokens in reading order. */
export function tokenize(text: string): string[] {
  return tokenRuns(text).flat()
}

/** Unigrams plus bigrams ("open source") of directly adjacent kept tokens. */
export function extractTerms(text: string): string[] {
  const terms: string[] = []
  for (const run of tokenRuns(text)) {
    for (let i = 0; i < run.length; i++) {
      terms.push(run[i]!)
      if (i > 0 && run[i - 1] !== run[i]) terms.push(`${run[i - 1]} ${run[i]}`)
    }
  }
  return terms
}
