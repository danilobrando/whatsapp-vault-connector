#!/usr/bin/env node
/**
 * whatsapp-vault-connector
 * Copyright (c) 2026 Danny Bravo
 * MIT License — see LICENSE
 * https://github.com/danilobrando/whatsapp-vault-connector
 */

/**
 * WhatsApp MCP Server for Claude Code
 *
 * Exposes WhatsApp messaging via MCP tools:
 *   - whatsapp_send: Send a message (via daemon IPC)
 *   - whatsapp_search_contacts: Find contacts by name
 *   - whatsapp_read_recent: Read recent messages from vault
 *   - whatsapp_daemon_status: Check daemon health
 *
 * Reads from vault files. Sends via Unix socket to the daemon.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const VAULT_ROOT = path.resolve(__dir, '..', '..', '..')
const WA_INBOX = path.join(VAULT_ROOT, '⚙️ Meta', 'whatsapp-inbox')
const SOCKET_PATH = '/tmp/whatsapp-daemon.sock'

// ── Daemon IPC client ────────────────────────────────────────────────────────

function sendToDaemon(cmd) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCKET_PATH, () => {
      client.write(JSON.stringify(cmd) + '\n')
    })
    let buffer = ''
    client.on('data', (data) => {
      buffer += data.toString()
      if (buffer.includes('\n')) {
        client.destroy()
        try { resolve(JSON.parse(buffer.trim())) }
        catch { reject(new Error('Invalid response from daemon')) }
      }
    })
    client.on('error', (err) => {
      reject(new Error(`Daemon not running (${err.code}). Run 'wa-fix.py fix' to auto-repair, or start the launchd job manually.`))
    })
    client.setTimeout(10000, () => {
      client.destroy()
      reject(new Error('Daemon timeout'))
    })
  })
}

// ── Contact resolution (from vault files) ────────────────────────────────────

function searchContacts(query) {
  const results = []
  const q = query.toLowerCase()

  if (fs.existsSync(WA_INBOX)) {
    for (const file of fs.readdirSync(WA_INBOX)) {
      if (!file.endsWith('.md')) continue
      const name = file.replace('.md', '').replace(/ \(\d+\)$/, '')
      if (!name.toLowerCase().includes(q)) continue

      const content = fs.readFileSync(path.join(WA_INBOX, file), 'utf8')
      const phoneMatch = content.match(/phone:\s*"?\+?(\d+)"?/)
      const phone = phoneMatch ? phoneMatch[1] : null
      if (phone) {
        results.push({ name, phone, jid: phone + '@s.whatsapp.net', file })
      }
    }
  }

  return results
}

function resolveContact(nameOrPhone) {
  const clean = nameOrPhone.replace(/[+\-\s]/g, '')
  if (/^\d{7,}$/.test(clean)) {
    return { jid: clean + '@s.whatsapp.net', displayName: '+' + clean }
  }
  const results = searchContacts(nameOrPhone)
  if (results.length === 0) return null
  return { jid: results[0].jid, displayName: results[0].name }
}

// ── Read recent messages from vault ──────────────────────────────────────────

function readRecent(contactQuery, count = 20) {
  const q = contactQuery.toLowerCase()
  let targetFile = null

  if (fs.existsSync(WA_INBOX)) {
    for (const file of fs.readdirSync(WA_INBOX)) {
      if (!file.endsWith('.md')) continue
      if (file.toLowerCase().includes(q)) {
        targetFile = path.join(WA_INBOX, file)
        break
      }
    }
  }

  if (!targetFile) return null

  const content = fs.readFileSync(targetFile, 'utf8')
  const lines = content.split('\n')
  const messageLines = lines.filter(l => l.startsWith('**'))
  return {
    file: path.basename(targetFile),
    total: messageLines.length,
    recent: messageLines.slice(-count).join('\n'),
  }
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'whatsapp', version: '2.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'whatsapp_send',
      description: 'Send a WhatsApp message to a contact. Provide name or phone number.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Contact name (e.g. "Alex") or phone number in E.164 format (e.g. "+15551234567")' },
          message: { type: 'string', description: 'Message text to send' },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'whatsapp_search_contacts',
      description: 'Search WhatsApp contacts by name. Returns matches with phone numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Name or partial name to search for' },
        },
        required: ['query'],
      },
    },
    {
      name: 'whatsapp_read_recent',
      description: 'Read recent messages from a WhatsApp conversation. Messages are synced in real-time by the daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          contact: { type: 'string', description: 'Contact name to read messages from' },
          count: { type: 'number', description: 'Number of recent messages to return (default: 20)' },
        },
        required: ['contact'],
      },
    },
    {
      name: 'whatsapp_daemon_status',
      description: 'Check WhatsApp daemon connection status and health.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  if (name === 'whatsapp_search_contacts') {
    const results = searchContacts(args.query)
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `No contacts found matching "${args.query}".` }] }
    }
    const lines = results.map(r => `${r.name} — ${r.phone} (${r.jid})`).join('\n')
    return { content: [{ type: 'text', text: `Found ${results.length} contact(s):\n${lines}` }] }
  }

  if (name === 'whatsapp_read_recent') {
    const data = readRecent(args.contact, args.count || 20)
    if (!data) {
      return { content: [{ type: 'text', text: `No conversation found for "${args.contact}".` }] }
    }
    return {
      content: [{
        type: 'text',
        text: `${data.file} (${data.total} total messages)\n\nLast ${args.count || 20}:\n${data.recent}`,
      }],
    }
  }

  if (name === 'whatsapp_send') {
    const resolved = resolveContact(args.to)
    if (!resolved) {
      return {
        content: [{ type: 'text', text: `Contact "${args.to}" not found. Use whatsapp_search_contacts to find the right name.` }],
        isError: true,
      }
    }
    try {
      const resp = await sendToDaemon({ cmd: 'send', jid: resolved.jid, text: args.message })
      if (resp.ok) {
        return { content: [{ type: 'text', text: `Message sent to ${resolved.displayName} (${resolved.jid})` }] }
      }
      return { content: [{ type: 'text', text: `Send failed: ${resp.error}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true }
    }
  }

  if (name === 'whatsapp_daemon_status') {
    try {
      const resp = await sendToDaemon({ cmd: 'status' })
      if (resp.ok) {
        const upHrs = Math.floor(resp.uptime / 3600)
        const upMin = Math.floor((resp.uptime % 3600) / 60)
        return {
          content: [{
            type: 'text',
            text: [
              `Connected: ${resp.connected ? 'yes' : 'no'}`,
              `Uptime: ${upHrs}h ${upMin}m`,
              `Last message: ${resp.lastMessageAt || 'none'}`,
              `File index: ${resp.indexSize} conversations`,
              `Contacts: ${resp.contactCount}`,
            ].join('\n'),
          }],
        }
      }
      return { content: [{ type: 'text', text: `Daemon error: ${resp.error}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true }
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  process.stderr.write(`MCP server fatal: ${err.message}\n`)
  process.exit(1)
})
