import type { Verify } from '../verify'

// Search tweets and likes, including matches found only in AI image captions,
// then open a result in the detail panel and close it.
// VERIFY_QUERY overrides the query (default "kitten": in the author's archive
// it matches tweets by their image captions).
export default async function search(v: Verify) {
  const { page } = v
  const query = process.env.VERIFY_QUERY ?? 'kitten'

  await v.open('constellation')
  const box = page.getByPlaceholder('Search tweets & likes…')
  await box.click()
  await box.fill(query)
  const results = page.getByRole('button').filter({ hasText: /Liked|You ·/ })
  await results.first().waitFor({ timeout: 10_000 })
  const count = await results.count()
  v.check(count > 0, `no results for "${query}"`)
  v.step(`Typed "${query}" → ${count} results in the dropdown`)

  const viaImage = results.filter({ hasText: 'Image ·' })
  const imageHits = await viaImage.count()
  v.step(`${imageHits} results explain an image-caption match ("Image · …")`)
  await v.shot('01-results')
  await v.aria('01-results')

  const target = imageHits ? viaImage.first() : results.first()
  await target.click()
  const panel = page.getByRole('link', { name: /Open on X/ })
  await panel.waitFor({ timeout: 10_000 })
  v.step('Clicked a result → the detail panel opens with "Open on X"')
  await page.waitForTimeout(2000)
  if (imageHits)
    v.check(
      await page.getByText('Image ·').first().isVisible(),
      'detail panel does not show the image caption'
    )
  await v.shot('02-detail')
  await v.aria('02-detail')

  await page.getByRole('button', { name: 'Close' }).click()
  await panel.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  v.check(!(await panel.isVisible()), 'detail panel did not close')
  v.step('Clicked Close → the detail panel closes')
}
