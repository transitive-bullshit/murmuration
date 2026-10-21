import type { Verify } from '../verify'

// Orbit: play the audience through time, and open a close relationship.
export default async function orbit(v: Verify) {
  const { page } = v

  await v.open('orbit')
  const play = page.getByRole('button', { name: 'Play through time' })
  await play.click()
  const pause = page.getByRole('button', { name: 'Pause' })
  await pause.waitFor({ timeout: 5000 })
  v.step('Clicked "Play through time" → the button becomes "Pause"')
  await page.waitForTimeout(2500)
  await v.shot('01-playing')
  await pause.click()
  await play.waitFor({ timeout: 5000 })
  v.step('Clicked "Pause" → playback stops')

  const closest = page.locator('section').filter({ hasText: 'Closest' }).first()
  const person = closest.getByRole('button').first()
  const handle = (await person.innerText()).split('\n')[0]
  await person.click()
  await page.getByText('Closeness over time').waitFor({ timeout: 10_000 })
  v.step(`Clicked ${handle} under Closest → the Person panel shows "Closeness over time"`)
  await page.waitForTimeout(2000)
  await v.shot('02-person')
  await v.aria('02-person')
}
