const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const assert = require('node:assert/strict')
;(async () => {
  const browser = await chromium.launch({headless:true})
  try {
    const page = await browser.newPage({viewport:{width:1440,height:960}})
    const errors = []
    page.on('pageerror', error=>errors.push(error.message))
    await page.goto('http://127.0.0.1:5175/novel-preview.html?view=library')
    await page.locator('.folio').waitFor()
    await page.screenshot({path:'novel-home-desktop.png'})
    await page.locator('.folio-resume [data-open-novel]').click()
    assert.equal(await page.locator('#novelChapterTitle').innerText(),'渡口的来信')
    await page.locator('#novelBack').click()
    await page.locator('.folio-recent-item').nth(2).click()
    assert.equal(await page.locator('#novelChapterTitle').innerText(),'雨停之后')
    await page.locator('#novelBack').click()
    await page.locator('[data-read-novel]').click()
    await page.locator('.reading-room').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('#novelBack').click()
    await page.locator('#novelSearch').fill('没有这本作品')
    assert.equal(await page.locator('.folio-work:visible').count(),0)
    assert.equal(await page.locator('#folioNoResults').isVisible(),true)
    await page.locator('#novelSort').selectOption('title')
    assert.equal(await page.locator('#novelSearch').inputValue(),'没有这本作品')
    await page.locator('#folioClearSearch').click()
    assert.equal(await page.locator('.folio-work:visible').count(),1)
    await page.locator('[data-layout=list]').click()
    assert.equal(await page.locator('.folio-grid.is-list').count(),1)
    await page.locator('[data-layout=grid]').click()
    await page.evaluate(() => {
      const base = window.previewWorkspace.novels[0]
      for (const [i,title] of ['第七封信','消失的海岸线','夜航档案'].entries()) {
        const book = structuredClone(base)
        book.id = 'sample-'+i
        book.title = title
        book.cover = ['#745677','#32776d','#495579'][i]
        book.summary = ['一场跨越十年的重逢，藏在七封从未寄出的信中。','潮水退去之后，海岸线上多出了一座无人知晓的城市。','夜航船上的每一位乘客，都带着一个不能被知道的秘密。'][i]
        book.updatedAt -= (i+1)*86400000
        window.previewWorkspace.novels.push(book)
      }
    })
    await page.locator('#novelSort').selectOption('updated')
    await page.screenshot({path:'novel-home-collection.png'})
    await page.setViewportSize({width:390,height:844})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    await page.screenshot({path:'novel-home-mobile.png',fullPage:true})
    await page.locator('#novelCreate').click()
    await page.locator('#qc-title').fill('新作品')
    await page.locator('#qc-ok').click()
    await page.locator('[data-act=first]').waitFor()
    await page.locator('#novelBack').click()
    await page.evaluate(()=>{window.previewWorkspace.novels=[]})
    await page.locator('#novelSort').selectOption('title')
    await page.locator('#novelEmptyCreate').waitFor()
    await page.screenshot({path:'novel-home-empty.png'})
    assert.deepEqual(errors,[])
    console.log('PASS: resume, recent chapters, reader, search, sort, layout, create, empty state, desktop/mobile.')
  } finally { await browser.close() }
})().catch(error=>{console.error(error);process.exitCode=1})
