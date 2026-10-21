// Regenerates the readme screenshots (media/*.webp, 1440×900 at 2×) and the
// social share image (public/og.jpg, 1200×630) from the production build.
//
//   pnpm shots                    # builds first, then writes both
//   tsx scripts/shots.ts --only og|readme
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import sharp from 'sharp'

import type { DatasetMeta } from '../src/shared/types'
import {
  HIDE_UI,
  launchBrowser,
  openPage,
  openView,
  root,
  servePreview,
  type ViewId
} from './lib/browser'

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    // Which Growth inflection the growth-focus shot opens.
    inflection: { type: 'string', default: 'Jan 2023' }
  }
})

const SHARE_CSS = `
  .og {
    position: fixed; inset: 0; z-index: 100; pointer-events: none;
    background:
      linear-gradient(90deg, rgba(3,4,6,.94) 0%, rgba(3,4,6,.82) 26%, rgba(3,4,6,.35) 46%, rgba(3,4,6,0) 60%),
      linear-gradient(0deg, rgba(3,4,6,.55) 0%, rgba(3,4,6,0) 22%);
    font-family: ui-sans-serif, -apple-system, 'SF Pro Display', system-ui, sans-serif;
    color: #f3f2ee;
  }
  .og .copy { position: absolute; left: 76px; top: 50%; transform: translateY(-50%); width: 470px; }
  .og .kicker { display: flex; align-items: center; gap: 12px; font-size: 21px; color: #b9b8b1; letter-spacing: -0.005em; }
  .og .kicker svg { width: 40px; height: 40px; }
  .og h1 { margin: 22px 0 0; font-size: 84px; line-height: .95; font-weight: 600; letter-spacing: -0.045em; }
  .og p { margin: 22px 0 0; font-size: 27px; line-height: 1.3; color: #d6d4cd; letter-spacing: -0.01em; }
  .og .url { position: absolute; left: 76px; bottom: 46px; font-size: 18px; color: #8f8e88; letter-spacing: 0.01em; }
`

const README: { file: string; view: ViewId; focus?: boolean }[] = [
  { file: 'constellation', view: 'constellation' },
  { file: 'growth-focus', view: 'growth', focus: true },
  { file: 'strata', view: 'strata' },
  { file: 'anatomy', view: 'anatomy' },
  { file: 'orbit', view: 'orbit' }
]

const server = await servePreview()
const browser = await launchBrowser()
try {
  if (args.only !== 'og') {
    const { page } = await openPage(browser, { scale: 2 })
    for (const shot of README) {
      await openView(page, server.url, shot.view)
      if (shot.focus) {
        // Click the inflection in the Growth panel; the camera flies to it.
        await page
          .locator('aside button')
          .filter({ hasText: args.inflection! })
          .filter({ hasText: /surge|spike/i })
          .first()
          .click()
        await page.waitForTimeout(3000)
      }
      const file = path.join(root, 'media', `${shot.file}.webp`)
      await sharp(await page.screenshot({ type: 'png' }))
        .webp({ quality: 80 })
        .toFile(file)
      console.log(`wrote ${path.relative(root, file)}`)
    }
    await page.context().close()
  }

  if (args.only !== 'readme') await shareImage()
} finally {
  await browser.close()
  server.stop()
}

/** The constellation with a title over the space the side panel leaves. */
async function shareImage() {
  const { meta } = JSON.parse(
    readFileSync(path.join(root, 'data', 'dataset.json'), 'utf8')
  ) as { meta: DatasetMeta }
  const { homepage } = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8')
  ) as { homepage?: string }
  const { account } = meta
  const { page } = await openPage(browser, {
    width: 1200,
    height: 630,
    scale: 2
  })
  await openView(page, server.url, 'constellation')
  await page.addStyleTag({ content: HIDE_UI + SHARE_CSS })
  await page.evaluate(
    ({ byline, site }) => {
      const dots = [
        [9, 19, 1.3],
        [12.5, 15.5, 1.1],
        [16, 13.5, 1.6],
        [19.5, 15, 1],
        [22.5, 12, 0.9],
        [14.5, 20, 0.8],
        [20, 19.5, 0.8],
        [25, 16.5, 0.7],
        [7, 14, 0.6],
        [11, 10.5, 0.6]
      ]
        .map(
          ([x, y, r], i) =>
            `<circle cx="${x}" cy="${y}" r="${r! * 1.25}" fill="${i % 3 === 0 ? '#f0c48a' : '#a9c8f2'}"/>`
        )
        .join('')
      const el = document.createElement('div')
      el.className = 'og'
      el.innerHTML = `
        <div class="copy">
          <div class="kicker"><svg viewBox="0 0 32 32" aria-hidden="true">${dots}</svg><span></span></div>
          <h1>murmuration</h1>
          <p>Every tweet and like on X, arranged by meaning, in 3D.</p>
        </div>
        <div class="url"></div>`
      el.querySelector('.kicker span')!.textContent = byline
      el.querySelector('.url')!.textContent = site
      document.body.append(el)
    },
    {
      byline: `${account.name || `@${account.handle}`} · @${account.handle}`,
      site: homepage ? new URL(homepage).host : ''
    }
  )
  await page.waitForTimeout(300)
  const file = path.join(root, 'public', 'og.jpg')
  writeFileSync(
    file,
    await sharp(await page.screenshot({ type: 'png' }))
      .resize(1200, 630, { kernel: 'lanczos3' })
      .jpeg({
        quality: 82,
        mozjpeg: true,
        progressive: true,
        chromaSubsampling: '4:4:4'
      })
      .toBuffer()
  )
  console.log(`wrote ${path.relative(root, file)}`)
  await page.context().close()
}
