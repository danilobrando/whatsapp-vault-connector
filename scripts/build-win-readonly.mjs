#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * Build `whatsapp-connector-win-readonly-v3.0.0.zip`.
 *
 * The artifact is what the product's launcher downloads onto a Windows 11
 * machine with no administrator: portable Node (documented in
 * `windows/NODE-VERSION`) plus this read-only connector and its already-resolved
 * production dependencies. `sharp` is excluded — it is a peer dependency Baileys
 * only needs for media it does not use here, and shipping it would drag in
 * native binaries for no reason.
 *
 * Reproducibility is a feature: entries are sorted, timestamps fixed and stored
 * uncompressed, so two builds of the same tree hash identically. If that ever
 * breaks, the build says so instead of quietly producing a new hash.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { builtinModules } from 'module'
import { fileURLToPath } from 'url'
import { writeZip } from './lib/zip.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..') // repository root
const SCRIPTS = path.join(ROOT, 'scripts')

const EXCLUDE_DIRS = new Set(['sharp', '.bin', '.cache'])
const EXCLUDE_PREFIX = ['@img']
const PACKAGE_MANIFEST = 'node_modules/.readonly-packages.json'
const DEPENDENCY_MANIFEST = 'node_modules/.readonly-manifest.sha256'
const BUILTIN_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      if (EXCLUDE_PREFIX.some((p) => rel === p || rel.startsWith(p + '/'))) continue
      walk(full, base, out)
    } else if (entry.isFile()) {
      out.push({ rel, full })
    }
  }
  return out
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function isBarePackageSpecifier(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !BUILTIN_MODULES.has(specifier)
}

function importedSpecifiers(source) {
  const found = new Set()
  const importRe = /(?:\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(importRe)) {
    if (isBarePackageSpecifier(match[1])) found.add(packageNameFromSpecifier(match[1]))
  }
  return found
}

function packageJsonAt(packageDir) {
  const file = path.join(packageDir, 'package.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function packageDirFrom(fromPath, packageName) {
  let cursor = fs.statSync(fromPath).isDirectory() ? fromPath : path.dirname(fromPath)
  const scriptsParent = path.dirname(SCRIPTS)
  while (cursor === SCRIPTS || cursor.startsWith(`${SCRIPTS}${path.sep}`)) {
    const candidate = path.join(cursor, 'node_modules', ...packageName.split('/'))
    if (packageJsonAt(candidate)) return candidate
    if (cursor === scriptsParent) break
    const parent = path.dirname(cursor)
    if (parent === cursor || !parent.startsWith(scriptsParent)) break
    cursor = parent
  }
  return null
}

function productionSourceFiles() {
  const files = walk(path.join(SCRIPTS, 'win'))
    .filter(({ rel }) => !rel.startsWith('test/') && rel !== 'test')
    .filter(({ full }) => /\.(?:mjs|cjs|js)$/.test(full))
  const authState = path.join(SCRIPTS, 'atomic-auth-state.mjs')
  if (fs.existsSync(authState)) files.push({ rel: 'atomic-auth-state.mjs', full: authState })
  return files
}

/**
 * Calculate the installed production closure for the files that ship.
 *
 * This deliberately starts at the imports in win/ and atomic-auth-state.mjs,
 * rather than at scripts/package.json. The latter also describes the macOS
 * MCP server, which must stay in the repository but must not enter this ZIP.
 */
export function calculateProductionClosure() {
  const roots = new Set()
  for (const file of productionSourceFiles()) {
    for (const specifier of importedSpecifiers(fs.readFileSync(file.full, 'utf8'))) roots.add(specifier)
  }

  const packages = new Map()
  const queue = [...roots].sort().map((name) => ({ name, from: SCRIPTS }))
  while (queue.length) {
    const { name, from } = queue.shift()
    const dir = packageDirFrom(from, name)
    if (!dir) throw new Error(`Cannot resolve production dependency ${name} from ${from}`)
    const rel = path.relative(path.join(SCRIPTS, 'node_modules'), dir).split(path.sep).join('/')
    if (EXCLUDE_PREFIX.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`)) || rel === 'sharp') {
      throw new Error(`Production dependency ${name} resolves to excluded package ${rel}`)
    }
    if (packages.has(dir)) continue

    const packageJson = packageJsonAt(dir)
    packages.set(dir, { dir, rel, packageJson })
    const dependencies = {
      ...(packageJson.dependencies || {}),
      ...(packageJson.optionalDependencies || {}),
    }
    for (const dependency of Object.keys(dependencies).sort()) {
      const child = packageDirFrom(dir, dependency)
      if (!child) {
        if (packageJson.optionalDependencies?.[dependency]) continue
        throw new Error(`Cannot resolve ${dependency}, required by ${rel}`)
      }
      queue.push({ name: dependency, from: dir })
    }
  }

  return {
    roots: [...roots].sort(),
    packages: [...packages.values()].sort((a, b) => a.rel.localeCompare(b.rel)),
  }
}

function minimalPackageJson(source, closure) {
  const dependencies = {}
  for (const root of closure.roots) {
    const packageInfo = closure.packages.find(({ packageJson }) => packageJson.name === root)
    if (!packageInfo) throw new Error(`Root package ${root} is not in the calculated closure`)
    dependencies[root] = packageInfo.packageJson.version
  }
  return {
    name: source.name,
    version: source.version,
    private: true,
    type: 'module',
    dependencies,
  }
}

function minimalPackageLock(sourceLock, minimalPackage, closure) {
  const packages = { '': minimalPackage }
  for (const { rel } of closure.packages) {
    const key = `node_modules/${rel}`
    const lockPackage = sourceLock.packages?.[key]
    if (!lockPackage) throw new Error(`Missing package-lock entry for ${key}`)
    packages[key] = lockPackage
  }
  return { name: minimalPackage.name, version: minimalPackage.version, lockfileVersion: 3, requires: true, packages }
}

function packageManifest(closure) {
  return {
    schema: 1,
    roots: closure.roots,
    packages: closure.packages.map(({ rel, packageJson }) => ({
      path: rel,
      name: packageJson.name,
      version: packageJson.version,
    })),
  }
}

function packageRootsForFile(file) {
  const parts = file.split('/')
  const roots = []
  const endOfPackageName = (index) => parts[index]?.startsWith('@') ? index + 2 : index + 1
  let end = endOfPackageName(0)
  roots.push(parts.slice(0, end).join('/'))
  for (let i = end; i < parts.length; i++) {
    if (parts[i] !== 'node_modules' || i + 1 >= parts.length) continue
    end = endOfPackageName(i + 1)
    roots.push(parts.slice(0, end).join('/'))
    i = end - 1
  }
  return roots
}

function collect(closure, sourcePackageJson, sourceLock) {
  const entries = []

  // Connector source (kept under win/ so its relative imports resolve).
  for (const f of walk(path.join(SCRIPTS, 'win'))) {
    if (f.rel === 'test' || f.rel.startsWith('test/')) continue
    entries.push({ name: `win/${f.rel}`, full: f.full })
  }
  // The atomic auth writer the adapter reuses, and a minimal manifest that
  // describes only the Windows production tree. The repository package.json
  // also contains the macOS MCP SDK and is intentionally not copied here.
  entries.push({ name: 'atomic-auth-state.mjs', full: path.join(SCRIPTS, 'atomic-auth-state.mjs') })
  const minimalPackage = minimalPackageJson(sourcePackageJson, closure)
  entries.push({ name: 'package.json', data: Buffer.from(`${JSON.stringify(minimalPackage, null, 2)}\n`) })
  entries.push({
    name: 'package-lock.json',
    data: Buffer.from(`${JSON.stringify(minimalPackageLock(sourceLock, minimalPackage, closure), null, 2)}\n`),
  })
  // Portable Node version contract.
  const nodeVersion = path.join(ROOT, 'windows', 'NODE-VERSION')
  if (fs.existsSync(nodeVersion)) entries.push({ name: 'NODE-VERSION', full: nodeVersion })
  // Only the installed package directories in the calculated closure. This
  // excludes the MCP SDK, express, proxy-addr and everything exclusive to it.
  const packageFiles = new Map()
  const packagePaths = new Set(closure.packages.map(({ rel }) => rel))
  for (const { dir, rel } of closure.packages) {
    for (const f of walk(dir)) {
      const name = `node_modules/${rel}/${f.rel}`
      if (packageRootsForFile(name.slice('node_modules/'.length)).every((root) => packagePaths.has(root))) {
        packageFiles.set(name, f.full)
      }
    }
  }
  for (const [name, full] of [...packageFiles.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entries.push({ name, full })
  }
  entries.push({ name: PACKAGE_MANIFEST, data: Buffer.from(`${JSON.stringify(packageManifest(closure), null, 2)}\n`) })
  return entries
}

function dependencyManifest(files) {
  return files
    .filter((file) => file.name.startsWith('node_modules/'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file) => `${crypto.createHash('sha256').update(file.data).digest('hex')}  ${file.name.slice('node_modules/'.length)}`)
    .join('\n') + '\n'
}

function main() {
  const pkgFile = path.join(SCRIPTS, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package-lock.json'), 'utf8'))
  const closure = calculateProductionClosure()
  const version = pkg.version
  const outDir = arg('--out', path.join(ROOT, 'windows'))
  const name = `whatsapp-connector-win-readonly-v${version}.zip`
  const outFile = path.join(outDir, name)

  const files = collect(closure, pkg, lock).map((e) => ({ name: e.name, data: e.data || fs.readFileSync(e.full) }))
  files.push({ name: DEPENDENCY_MANIFEST, data: Buffer.from(dependencyManifest(files)) })
  const zip = writeZip(files)

  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, zip)
  const sha = crypto.createHash('sha256').update(zip).digest('hex')
  fs.writeFileSync(`${outFile}.sha256`, `${sha}  ${name}\n`)

  process.stdout.write(`built ${name}\n`)
  process.stdout.write(`  files:  ${files.length}\n`)
  process.stdout.write(`  bytes:  ${zip.length}\n`)
  process.stdout.write(`  sha256: ${sha}\n`)
  process.stdout.write(`  roots:  ${closure.roots.join(', ')}\n`)
  process.stdout.write(`  packages: ${closure.packages.length}\n`)
  process.stdout.write(`  out:    ${outFile}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main()
