import type { Verify } from '../verify'

// Growth: open a follower inflection and see its most likely causes.
// VERIFY_INFLECTION picks the inflection (default "Jan 2023", the author's
// largest surge).
export default async function growth(v: Verify) {
  const { page } = v
  const label = process.env.VERIFY_INFLECTION ?? 'Jan 2023'

  await v.open('growth')
  const list = page.locator('section').filter({ hasText: 'Follower inflections' })
  const item = list.getByRole('button').filter({ hasText: label }).first()
  await item.waitFor({ timeout: 10_000 })
  v.step(`The Follower inflections list includes "${label}"`)
  await v.shot('01-growth')

  await item.click()
  const causes = page.getByText('Most likely causes')
  await causes.waitFor({ timeout: 10_000 })
  v.step(`Clicked "${label}" → the panel shows "Most likely causes"`)
  await page.waitForTimeout(3000)
  await v.shot('02-inflection')
  await v.aria('02-inflection')

  await page.keyboard.press('Escape')
  await causes.waitFor({ state: 'detached', timeout: 5000 })
  v.step('Pressed Escape → back to the inflection list')
}
