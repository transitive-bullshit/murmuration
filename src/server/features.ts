import { FMT, FORMATS, type Format } from '../shared/types'
import type { RawTweet } from './load'

const STATUS_URL =
  /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/(\w+)\/status\/\d+/i

export interface TweetFeatures {
  flags: number
  format: Format
  len: number
  /** handle of a quoted / linked status, when present */
  quotedHandle: string | undefined
  /** handle being retweeted, when a pure retweet */
  retweetedHandle: string | undefined
}

export function visibleLength(text: string): number {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^(@\w+\s+)+/, '')
    .trim().length
}

/**
 * Classifies each tweet's shape. `selfThreadParents` holds ids of your tweets
 * that you replied to yourself (i.e. thread heads or middles).
 */
export function tweetFeatures(
  tweet: RawTweet,
  ctx: { selfProfileId: string; selfThreadParents: Set<string> }
): TweetFeatures {
  let flags = 0
  const text = tweet.text
  const retweetMatch = /^RT @(\w+):/.exec(text)
  const isRetweet = tweet.kind === 'mine' && !!retweetMatch
  if (isRetweet) flags |= FMT.retweet

  const isReply = !!tweet.replyToId
  const isSelfReply = isReply && tweet.replyToProfileId === ctx.selfProfileId
  if (isReply) flags |= FMT.reply
  if (isSelfReply) flags |= FMT.selfReply | FMT.threadPart
  if (!isReply && ctx.selfThreadParents.has(tweet.id)) flags |= FMT.threadHead

  let quotedHandle: string | undefined
  for (const url of tweet.urls) {
    const m = STATUS_URL.exec(url)
    if (m) quotedHandle ??= m[1]
  }
  const externalLinks = tweet.urls.filter((u) => !STATUS_URL.test(u))
  if (tweet.quotedTweetId || quotedHandle) flags |= FMT.quote
  if (tweet.mediaType === 'image') flags |= FMT.image
  if (tweet.mediaType === 'video' || tweet.mediaType === 'gif')
    flags |= FMT.video
  if (externalLinks.length) flags |= FMT.link
  if (/\?\s*($|https?:)/m.test(text)) flags |= FMT.question
  if (tweet.hashtags > 0) flags |= FMT.hashtag
  if (tweet.mentions.length > (isReply ? 1 : 0)) flags |= FMT.mention

  let format: Format
  if (isRetweet) format = 'retweet'
  else if (isReply && !isSelfReply) format = 'reply'
  else if (flags & (FMT.threadHead | FMT.threadPart)) format = 'thread'
  else if (flags & FMT.quote) format = 'quote'
  else if (flags & FMT.video) format = 'video'
  else if (flags & FMT.image) format = 'image'
  else if (flags & FMT.link) format = 'link'
  else format = 'text'

  return {
    flags,
    format,
    len: visibleLength(text),
    quotedHandle,
    retweetedHandle: isRetweet ? retweetMatch?.[1] : undefined
  }
}

export const formatIndex = (format: Format) => FORMATS.indexOf(format)
