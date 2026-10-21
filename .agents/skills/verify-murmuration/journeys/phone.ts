import type { Verify } from '../verify'

// Phone layout at 375×812: views live in a menu sheet, insights start as a
// collapsed pill, and search opens in the sheet. VERIFY_QUERY overrides the
// query (default "kitten").
export default async function phone(v: Verify) {
  const { page } = v
  const query = process.env.VERIFY_QUERY ?? 'kitten'
  await page.setViewportSize({ width: 375, height: 812 })

  await v.open('strata')
  v.check(
    (await page.getByRole('navigation', { name: 'Views' }).count()) === 0,
    'the view tabs still show in the phone header'
  )
  const pill = page.getByRole('button', { name: 'Strata Insights' })
  v.check(await pill.isVisible(), 'the insights pill is missing')
  v.check(
    !(await page.getByText('By year').isVisible()),
    'insights are open by default on a phone'
  )
  v.step('Opened /strata at 375×812 → compact header, insights collapsed')
  await v.shot('01-strata')

  await page.getByRole('button', { name: 'Menu' }).click()
  const sheet = page.getByRole('dialog', { name: 'Menu' })
  await sheet.waitFor()
  v.step('Tapped Menu → the sheet lists the six views')
  await page.waitForTimeout(400) // the sheet's fade-in
  await v.shot('02-menu')
  await v.aria('02-menu')

  await sheet.getByRole('button', { name: /^Orbit/ }).click()
  await page.waitForURL('**/orbit')
  await sheet.waitFor({ state: 'detached' })
  v.step('Tapped Orbit → URL /orbit and the sheet closes')

  await page.getByRole('button', { name: 'Orbit Insights' }).click()
  const hide = page.getByRole('button', { name: /Hide/ })
  await hide.waitFor()
  v.step('Tapped the insights pill → the Orbit panel opens')
  await hide.click()
  await page.getByRole('button', { name: 'Orbit Insights' }).waitFor()
  v.step('Tapped Hide → back to the pill')

  // Orbit searches people, so tweet search is checked from Constellation.
  await page.getByRole('button', { name: 'Menu' }).click()
  await sheet.getByRole('button', { name: /^Constellation/ }).click()
  await page.waitForURL('**/constellation')
  await page.getByRole('button', { name: 'Search' }).click()
  await sheet.getByRole('textbox').fill(query)
  const results = sheet.getByRole('button').filter({ hasText: /Liked|You ·/ })
  await results.first().waitFor({ timeout: 10_000 })
  v.step(`Searched "${query}" in the sheet → results listed inline`)
  await v.shot('03-search')
  await results.first().click()
  await page.getByRole('link', { name: /Open on X/ }).waitFor()
  v.check(
    (await page.getByRole('dialog', { name: 'Menu' }).count()) === 0,
    'the sheet stayed open after picking a result'
  )
  v.step('Tapped a result → the sheet closes and the tweet opens')
  await page.waitForTimeout(1500)
  await v.shot('04-tweet')

  const scrolled = await page.evaluate(
    () => document.getElementById('root')!.scrollLeft
  )
  v.check(scrolled === 0, `the app scrolled sideways by ${scrolled}px`)
  v.step('The app never scrolls sideways')
}
