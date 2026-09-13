const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto('http://127.0.0.1:5175/novel-preview.html')
    await page.evaluate(async () => {
      const {bindWorkspaceReorder} = await import('/src/components/workspaceReorder.ts')
      document.body.innerHTML = '<div id="list" style="width:60px;height:240px;overflow:auto;display:flex;flex-direction:column;gap:2px"></div>'
      const list = document.querySelector('#list')
      window.clicks = 0
      window.commits = []
      for(let i=0;i<12;i++) {
        const el = document.createElement('button')
        el.className = 'ws-item'
        el.dataset.workspaceId = String(i)
        el.textContent = String(i)
        el.style.cssText = 'height:42px;flex-shrink:0'
        el.addEventListener('click',()=>window.clicks++)
        list.append(el)
      }
      window.dispose = bindWorkspaceReorder(list, ids=>window.commits.push(ids))
    })
    const order = () => page.locator('.ws-item').evaluateAll(els=>els.map(el=>el.dataset.workspaceId))
    const point = async index => {
      const box = await page.locator('.ws-item').nth(index).boundingBox()
      return {x:box.x+20,y:box.y+20}
    }
    await page.locator('.ws-item').first().click()
    assert.equal(await page.evaluate(()=>window.clicks),1)
    let p = await point(0)
    await page.mouse.move(p.x,p.y)
    await page.mouse.down()
    await page.waitForTimeout(360)
    await page.mouse.move(p.x,180)
    await page.mouse.up()
    assert.deepEqual((await order()).slice(0,4),['1','2','3','0'])
    assert.equal(await page.evaluate(()=>window.clicks),1)
    assert.equal(await page.evaluate(()=>window.commits.length),1)
    p = await point(0)
    await page.mouse.move(p.x,p.y)
    await page.mouse.down()
    await page.waitForTimeout(360)
    await page.mouse.move(p.x,150)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.deepEqual((await order()).slice(0,4),['1','2','3','0'])
    assert.equal(await page.evaluate(()=>window.commits.length),1)
    p = await point(0)
    await page.mouse.move(p.x,p.y)
    await page.mouse.down()
    await page.waitForTimeout(360)
    await page.mouse.move(p.x,240)
    await page.waitForTimeout(600)
    assert.ok(await page.locator('#list').evaluate(el=>el.scrollTop)>0)
    await page.mouse.up()
    assert.equal(await page.evaluate(()=>window.commits.length),2)
    await page.evaluate(()=>window.dispose())
    assert.equal(await page.locator('.ws-dragging').count(),0)
    console.log('PASS: short click, long-press reorder, no accidental click, cancel, edge auto-scroll, commit and cleanup.')
  } finally { await browser.close() }
})().catch(error=>{console.error(error);process.exitCode=1})
