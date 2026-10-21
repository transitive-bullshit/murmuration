import type { Verify } from '../verify'

// Six views: tab clicks, number keys, per-view URLs and Back/Forward.
export default async function views(v: Verify) {
  const { page } = v
  const tabs = page.getByRole('navigation', { name: 'Views' })

  await v.open('constellation')
  v.step('Opened /constellation; the Constellation panel is showing')
  await v.shot('01-constellation')

  await tabs.getByRole('button', { name: 'Strata', exact: true }).click()
  await page.waitForURL('**/strata')
  v.check(
    await page.locator('aside').filter({ hasText: 'Strata' }).first().isVisible(),
    'Strata panel did not appear after clicking its tab'
  )
  v.step('Clicked the Strata tab → URL /strata, Strata panel')

  await page.keyboard.press('6')
  await page.waitForURL('**/orbit')
  v.step('Pressed 6 → URL /orbit')
  await page.waitForTimeout(2500)
  await v.shot('02-orbit-via-key')

  await page.goBack()
  await page.waitForURL('**/strata')
  v.check(
    await page.locator('aside').filter({ hasText: 'Strata' }).first().isVisible(),
    'Back did not return to the Strata view'
  )
  v.step('Browser Back → URL /strata and the Strata panel again')

  await page.goto(`${v.base}/growth`)
  await page.locator('aside').filter({ hasText: 'Follower inflections' }).waitFor()
  v.step('Deep link /growth opens the Growth view directly')
  await page.waitForTimeout(2500)
  await v.shot('03-growth-deep-link')
  await v.aria('03-growth-deep-link')

  await page.goto(`${v.base}/`)
  await page.waitForURL('**/growth')
  v.step('Opening / restores the last view (/growth) in the URL')
}
