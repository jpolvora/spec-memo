/**
 * Push a local spec-memo vault archive into a remote SSE MCP server.
 * Identity caveat: always pass stable projectId (cwd on remote won't map).
 *
 * Usage (from spec-memo repo root after build):
 *   node scripts/push-vault-to-remote-mcp.mjs [archive.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const PROJECT_ID = 'dev.azure.com-7focus-marchanteerp-_git-marchanteerp';
const SSE_URL = process.env.SPEC_MEMO_SSE_URL || 'http://192.168.0.3:3000/sse';
const TOKEN =
  process.env.SPEC_MEMO_AUTH_TOKEN ||
  '49c696b064f8ae17f7edf098bf09996ed8ece837c7090cd693cc69b20948cfa8';
const ARCHIVE =
  process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME, 'spec-memo-marchanteerp-export.json');

const DIR_TO_KIND = {
  traps: 'trap',
  decisions: 'decision',
  specs: 'spec',
  plans: 'plan',
  logs: 'log',
  reviews: 'review',
  scratch: 'scratch',
};

function resolveKind(relativePath, frontmatterKind) {
  if (frontmatterKind && typeof frontmatterKind === 'string') return frontmatterKind;
  const dir = relativePath.split(/[/\\]/)[0];
  return DIR_TO_KIND[dir] || 'trap';
}

async function main() {
  const archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
  if (archive.format !== 'spec-memo-vault-v1') {
    throw new Error(`Unexpected archive format: ${archive.format}`);
  }
  const project = archive.projects.find((p) => p.projectId === PROJECT_ID) || archive.projects[0];
  if (!project) throw new Error('No project in archive');

  const transport = new SSEClientTransport(new URL(SSE_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    },
  });

  const client = new Client({ name: 'spec-memo-vault-push', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name);
  if (!toolNames.includes('upsert')) {
    throw new Error(`Remote MCP missing upsert. Tools: ${toolNames.join(', ')}`);
  }

  let ok = 0;
  let fail = 0;
  const errors = [];

  for (const record of project.records) {
    const parsed = matter(record.content);
    const kind = resolveKind(record.relativePath, parsed.data.kind);
    const slug =
      parsed.data.slug ||
      parsed.data.id ||
      path.basename(record.relativePath, '.md');

    const { id, kind: _k, project: _p, created, updated, slug: _s, ...rest } = parsed.data;
    const frontmatter = {
      ...rest,
      title: parsed.data.title || slug,
      status: parsed.data.status || 'active',
      source:
        parsed.data.source === 'agent' ||
        parsed.data.source === 'human' ||
        parsed.data.source === 'imported'
          ? parsed.data.source
          : 'imported',
    };

    try {
      const result = await client.callTool({
        name: 'upsert',
        arguments: {
          kind,
          slug: String(slug),
          projectId: PROJECT_ID,
          frontmatter,
          body: parsed.content || record.content,
        },
      });
      if (result.isError) {
        fail++;
        const msg =
          Array.isArray(result.content)
            ? result.content.map((c) => c.text || JSON.stringify(c)).join(' ')
            : JSON.stringify(result.content);
        errors.push({ slug, error: msg });
        process.stderr.write(`FAIL ${kind}/${slug}: ${msg}\n`);
      } else {
        ok++;
        if (ok % 20 === 0) process.stderr.write(`… ${ok} upserted\n`);
      }
    } catch (err) {
      fail++;
      errors.push({ slug, error: err instanceof Error ? err.message : String(err) });
      process.stderr.write(`FAIL ${kind}/${slug}: ${err}\n`);
    }
  }

  const search = await client.callTool({
    name: 'search',
    arguments: {
      projectId: PROJECT_ID,
      query: '*',
      includeScratch: true,
      limit: 5,
    },
  });

  await client.close();

  console.log(
    JSON.stringify(
      {
        projectId: PROJECT_ID,
        sseUrl: SSE_URL,
        archivePath: ARCHIVE,
        archiveRecords: project.records.length,
        upserted: ok,
        failed: fail,
        errors: errors.slice(0, 15),
        searchProbeRaw: search,
      },
      null,
      2
    )
  );

  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
