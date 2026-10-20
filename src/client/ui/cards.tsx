import { useState, type ReactNode } from 'react'

import { FMT, FORMATS, REL } from '../../shared/types'
import { FORMAT_HEX, KIND_HEX, REL_HEX } from '../data/color'
import {
  displayText,
  fmtCompact,
  fmtDate,
  fmtInt,
  fmtMonth,
  fmtMultiple
} from '../data/format'
import { KIND, type Model } from '../data/model'
import { useApp } from '../store'

const FORMAT_LABEL: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  link: 'Link',
  quote: 'Quote',
  thread: 'Thread',
  reply: 'Reply',
  retweet: 'Repost'
}

export function Chip({
  color,
  children
}: {
  color?: string
  children: ReactNode
}) {
  return (
    <span className='inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.04] px-2 py-0.5 text-[10.5px] font-medium text-ink-2'>
      {color && (
        <span className='size-1.5 rounded-full' style={{ background: color }} />
      )}
      {children}
    </span>
  )
}

export function Metric({
  label,
  value,
  accent
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div className='flex flex-col'>
      <span
        className={`text-[14px] font-semibold tabular leading-tight ${accent ? 'text-[#ffd59a]' : 'text-ink'}`}
      >
        {value}
      </span>
      <span className='text-[10px] uppercase tracking-[0.1em] text-ink-4'>
        {label}
      </span>
    </div>
  )
}

export function TweetSummary({
  model,
  index,
  full = false
}: {
  model: Model
  index: number
  full?: boolean
}) {
  const tw = model.ds.tweets
  const media = useApp((s) => s.mediaPreviews)
  const [mediaFailed, setMediaFailed] = useState(false)
  const kind = model.kind[index]!
  const format = FORMATS[model.format[index]!]!
  const author = tw.author[index]!
  const handle = author >= 0 ? model.ds.people.handle[author] : ''
  const cluster = model.ds.clusters[model.cluster[index]!]
  const isMine = kind === KIND.mine
  const lift = model.lift[index]!
  const flags = model.flags[index]!
  const text = displayText(tw.text[index]!)
  const mediaUrl = tw.media[index]!
  // AI description of the tweet's images (empty without an OpenAI key).
  const caption = tw.caption?.[index] ?? ''
  const showImage = media && mediaUrl !== '' && !mediaFailed

  return (
    <div className='flex flex-col gap-2.5'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <Chip
          color={
            isMine
              ? KIND_HEX.mine
              : kind === KIND.like
                ? KIND_HEX.like
                : KIND_HEX.bookmark
          }
        >
          {isMine ? 'You' : kind === KIND.like ? 'Liked' : 'Saved'}
          {!isMine && handle ? ` · @${handle}` : ''}
        </Chip>
        <Chip color={FORMAT_HEX[format]}>{FORMAT_LABEL[format]}</Chip>
        {flags & FMT.threadHead ? <Chip>Thread start</Chip> : null}
        <span className='ml-auto text-[11px] text-ink-3 tabular'>
          {fmtDate(model.t[index]!)}
        </span>
      </div>

      <p
        className={`whitespace-pre-line text-[13.5px] leading-[1.5] text-ink ${full ? '' : 'line-clamp-6'}`}
      >
        {text || '—'}
      </p>

      {showImage && (
        <img
          src={mediaUrl}
          alt={caption.replaceAll('\n', ' ')}
          loading='lazy'
          referrerPolicy='no-referrer'
          onError={() => setMediaFailed(true)}
          className={`w-full rounded-xl border border-white/[0.06] object-cover ${full ? 'max-h-72' : 'max-h-40'}`}
        />
      )}

      {caption && (full || !showImage) ? (
        <p
          className={`whitespace-pre-line text-[11.5px] leading-snug text-ink-3 ${full ? '' : 'line-clamp-2'}`}
        >
          <span className='text-ink-4'>Image · </span>
          {caption}
        </p>
      ) : null}

      {isMine || model.likes[index]! > 0 ? (
        <div className='flex items-end gap-5 border-t border-white/[0.06] pt-2.5'>
          <Metric label='likes' value={fmtCompact(model.likes[index]!)} />
          {model.rts[index]! >= 0 && (
            <Metric label='reposts' value={fmtCompact(model.rts[index]!)} />
          )}
          {tw.replies[index]! >= 0 && (
            <Metric label='replies' value={fmtCompact(tw.replies[index]!)} />
          )}
          {tw.views[index]! > 0 && (
            <Metric label='views' value={fmtCompact(tw.views[index]!)} />
          )}
          {isMine && model.analyzable[index] ? (
            <Metric
              label='vs. typical'
              value={fmtMultiple(lift)}
              accent={lift >= 3}
            />
          ) : null}
        </div>
      ) : null}

      {cluster && (
        <div className='text-[11px] text-ink-3'>
          Topic · <span className='text-ink-2'>{cluster.label}</span>
          {isMine && model.outlier[index]! >= 3 ? (
            <span className='ml-2 text-[#ffd59a]'>
              · outlier (z {model.outlier[index]!.toFixed(1)})
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function relLabel(rel: number) {
  const follower = !!(rel & REL.follower)
  const following = !!(rel & REL.following)
  if (follower && following) return { label: 'Mutual', color: REL_HEX.mutual }
  if (following) return { label: 'You follow', color: REL_HEX.following }
  if (follower) return { label: 'Follows you', color: REL_HEX.follower }
  return { label: 'Not connected', color: '#7c7b75' }
}

export function PersonSummary({
  model,
  index,
  full = false
}: {
  model: Model
  index: number
  /** detail view: also explain what the archive can't see */
  full?: boolean
}) {
  const p = model.ds.people
  const media = useApp((s) => s.mediaPreviews)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const rel = relLabel(p.rel[index]!)
  const handle = p.handle[index]
  const closeness = p.closeness[index]!
  // Only show what the data can actually back up. Your replies, mentions,
  // reposts and DMs come from the full archive, so zero means zero. Their
  // replies/mentions and your likes of their tweets are only partly synced,
  // so a zero there is unknown, not zero. Their likes of you aren't in any X
  // export, so we never show them.
  const metrics: { label: string; value: number }[] = [
    { label: 'your replies', value: p.outReplies[index]! },
    { label: 'your mentions', value: p.outMentions[index]! },
    { label: 'your reposts', value: p.outShares[index]! },
    { label: 'you liked', value: p.outLikes[index]! },
    { label: 'their replies', value: p.inMentions[index]! },
    { label: 'DMs', value: p.dmIn[index]! + p.dmOut[index]! }
  ].filter((m) => m.value > 0)
  return (
    <div className='flex flex-col gap-2.5'>
      <div className='flex items-center gap-2.5'>
        {media && p.avatar[index] && !avatarFailed ? (
          <img
            src={p.avatar[index]}
            alt=''
            referrerPolicy='no-referrer'
            onError={() => setAvatarFailed(true)}
            className='size-9 rounded-full border border-white/10 object-cover'
          />
        ) : (
          <span className='flex size-9 items-center justify-center rounded-full bg-white/[0.06] text-[13px] text-ink-3'>
            {(handle || '?').slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className='min-w-0'>
          <div className='truncate text-[13.5px] font-semibold text-ink'>
            {p.name[index] || (handle ? `@${handle}` : 'Unknown account')}
          </div>
          <div className='truncate text-[11.5px] text-ink-3'>
            {handle ? `@${handle}` : p.id[index]}
          </div>
        </div>
      </div>
      <div className='flex flex-wrap gap-1.5'>
        <Chip color={rel.color}>{rel.label}</Chip>
        {p.followers[index]! > 0 && (
          <Chip>{fmtCompact(p.followers[index]!)} followers</Chip>
        )}
        {p.followedAt[index]! > 0 && (
          <Chip>followed you ~{fmtMonth(p.followedAt[index]!)}</Chip>
        )}
      </div>
      <div>
        <div className='mb-1 flex justify-between text-[10.5px] text-ink-3'>
          <span>Closeness</span>
          <span className='tabular'>{Math.round(closeness * 100)}</span>
        </div>
        <div className='h-1 overflow-hidden rounded-full bg-white/[0.07]'>
          <div
            className='h-full rounded-full bg-gradient-to-r from-[#199e70] to-[#ffe2b0]'
            style={{ width: `${Math.max(2, closeness * 100)}%` }}
          />
        </div>
      </div>
      {metrics.length > 0 ? (
        <div className='grid grid-cols-3 gap-x-2 gap-y-2.5 border-t border-white/[0.06] pt-2.5'>
          {metrics.map((m) => (
            <Metric
              key={m.label}
              label={m.label}
              value={m.label === 'DMs' ? fmtCompact(m.value) : fmtInt(m.value)}
            />
          ))}
        </div>
      ) : (
        <div className='border-t border-white/[0.06] pt-2.5 text-[11.5px] text-ink-3'>
          No recorded interactions.
        </div>
      )}
      {full && (
        <p className='text-[10.5px] leading-relaxed text-ink-4'>
          X&apos;s archive doesn&apos;t record who liked your tweets, and only
          recent replies to you are synced, so those can&apos;t be shown in
          full.
        </p>
      )}
      {p.outlierReason[index] && (
        <div className='text-[11.5px] text-[#ffd59a]'>
          {p.outlierReason[index]}
        </div>
      )}
    </div>
  )
}
