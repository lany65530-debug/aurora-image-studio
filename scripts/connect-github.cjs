#!/usr/bin/env node
/**
 * 一键把项目接到你的 GitHub 仓库。
 * ------------------------------------------------------------
 * 用法：
 *   npm run connect:github -- 你的GitHub用户名
 *   npm run connect:github -- 你的GitHub用户名 仓库名      （仓库名默认 aurora-image-studio）
 *
 * 作用：把 package.json 里的 repository / build.publish.owner / build.publish.repo
 * 写成你的仓库，然后打印接下来的 git 命令。
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const owner = (args[0] || '').trim()
const repo = (args[1] || 'aurora-image-studio').trim()

if (!owner) {
  console.error('缺少 GitHub 用户名。用法：npm run connect:github -- 你的GitHub用户名 [仓库名]')
  process.exit(1)
}
if (/[^A-Za-z0-9-_.]/.test(owner) || /[^A-Za-z0-9-_.]/.test(repo)) {
  console.error('用户名 / 仓库名只能包含字母、数字、- _ .')
  process.exit(1)
}

const pkgPath = path.join(__dirname, '..', 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

pkg.repository = { type: 'git', url: `https://github.com/${owner}/${repo}.git` }
pkg.build.publish = [{ provider: 'github', owner, repo, releaseType: 'release' }]

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log('')
console.log(`✅ 已把发布目标设为 https://github.com/${owner}/${repo}`)
console.log('')
console.log('接下来在项目根目录依次执行：')
console.log('')
console.log('  git init')
console.log('  git add -A')
console.log('  git commit -m "chore: 接入 GitHub Releases 自动更新"')
console.log('  git branch -M main')
console.log(`  git remote add origin https://github.com/${owner}/${repo}.git`)
console.log('  git push -u origin main')
console.log('')
console.log('（先在 GitHub 网页上把这个空仓库建好，不要勾选 README/.gitignore）')
