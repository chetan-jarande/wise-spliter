#!/usr/bin/env node
/**
 * Wise-Spliter Multi-Agent Persona Verification Orchestrator (`agents/orchestrate-personas.mjs`)
 *
 * Single entrypoint to:
 *  1. Validate `AGENTS.md` + all 4 persona prompt specs (`agents/personas/*.md`) + repo punctuation hygiene
 *  2. Run the 5 deterministic verification gates (`typecheck`, `migrate-verify`, `test`, `build`, `e2e`)
 *  3. Generate contextualized dispatch packets (injecting live `git diff --stat` + changed files) for:
 *     - Phase A (Parallel): `test-author-e2e`, `red-team-hacker`, `ux-performance-breaker`
 *     - Phase B (Sequential Arbiter): `fact-checker-arbiter`
 *  4. Evaluate persona JSON reports and compute the binding `SHIP` / `BLOCK` consensus quorum.
 *
 * Usage:
 *   node agents/orchestrate-personas.mjs --phase check
 *   node agents/orchestrate-personas.mjs --phase prompts [--persona red-team-hacker]
 *   node agents/orchestrate-personas.mjs --phase gates [--skip-e2e]
 *   node agents/orchestrate-personas.mjs --phase evaluate --report <path-to-json>
 *   node agents/orchestrate-personas.mjs --phase all [--skip-e2e]
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const PERSONA_REGISTRY = [
  {
    id: 'test-author-e2e',
    phase: 'PHASE_A_PARALLEL',
    title: 'Persona 1: Independent E2E & Edge-Case Test Author',
    promptFile: 'agents/personas/test-author-e2e.md',
    skills: ['test-driven-development', 'verification-before-completion'],
    writablePaths: ['tests/e2e/', 'tests/unit/'],
  },
  {
    id: 'red-team-hacker',
    phase: 'PHASE_A_PARALLEL',
    title: 'Persona 2: Adversarial Red-Team Hacker',
    promptFile: 'agents/personas/red-team-hacker.md',
    skills: ['security-and-hardening', 'security-review', 'supabase'],
    writablePaths: ['tests/unit/security-breach.test.ts'],
  },
  {
    id: 'ux-performance-breaker',
    phase: 'PHASE_A_PARALLEL',
    title: 'Persona 3: Principal UX, Usability & Million-User Scale Breaker',
    promptFile: 'agents/personas/ux-performance-breaker.md',
    skills: ['ui-ux-pro-max', 'ponytail-review', 'investigate-first'],
    writablePaths: [],
  },
  {
    id: 'fact-checker-arbiter',
    phase: 'PHASE_B_ARBITER',
    title: 'Persona 4: Fact-Checker & Consensus Arbiter',
    promptFile: 'agents/personas/fact-checker-arbiter.md',
    skills: ['verification-before-completion', 'receiving-code-review'],
    writablePaths: [],
  },
];

function parseArgs(argv) {
  const opts = {
    phase: 'check',
    persona: null,
    reportPath: null,
    skipE2e: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--skip-e2e') opts.skipE2e = true;
    else if (arg === '--phase' && argv[i + 1]) opts.phase = argv[++i];
    else if (arg === '--persona' && argv[i + 1]) opts.persona = argv[++i];
    else if (arg === '--report' && argv[i + 1]) opts.reportPath = argv[++i];
  }
  return opts;
}

function getGitContext() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const headCommit = execSync('git log -n 1 --oneline', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const statusShort = execSync('git status --short', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const diffStat = execSync('git diff HEAD~1 --stat 2>/dev/null || git status --short', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    return { branch, headCommit, statusShort, diffStat };
  } catch {
    return {
      branch: 'main',
      headCommit: 'unknown',
      statusShort: '',
      diffStat: '',
    };
  }
}

const MAX_AGENTS_MD_BYTES = 4500;

export function validatePersonaFiles() {
  const requiredDocs = [
    'AGENTS.md',
    'docs/coding-standards.md',
    'agents/ORCHESTRATOR.md',
    ...PERSONA_REGISTRY.map((p) => p.promptFile),
  ];

  const results = [];
  for (const relPath of requiredDocs) {
    const absPath = resolve(REPO_ROOT, relPath);
    if (!existsSync(absPath)) {
      results.push({ file: relPath, ok: false, error: 'Missing file' });
      continue;
    }
    const content = readFileSync(absPath, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (content.trim().length < 100) {
      results.push({
        file: relPath,
        ok: false,
        error: `File too short (${content.trim().length} chars)`,
      });
      continue;
    }
    if (relPath === 'AGENTS.md' && bytes > MAX_AGENTS_MD_BYTES) {
      results.push({
        file: relPath,
        ok: false,
        error: `AGENTS.md exceeds ${MAX_AGENTS_MD_BYTES}-byte context budget (${bytes} bytes). Move details to docs/coding-standards.md.`,
      });
      continue;
    }
    if (/[\u2013\u2014]/.test(content)) {
      results.push({
        file: relPath,
        ok: false,
        error: 'Contains forbidden em/en-dash (U+2013/U+2014)',
      });
      continue;
    }
    results.push({
      file: relPath,
      ok: true,
      lines: content.split('\n').length,
      bytes,
    });
  }

  return {
    ok: results.every((r) => r.ok),
    files: results,
  };
}

export function runDeterministicGates({ skipE2e = false } = {}) {
  const gates = [
    { id: 'typecheck', label: 'Static Types & Zero-Deprecation Gate', cmd: 'make typecheck' },
    { id: 'migrateVerify', label: 'Supabase wise_spliter Schema & FORCE RLS Gate', cmd: 'make migrate-verify' },
    { id: 'unitTests', label: 'Vitest Domain, Math Fuzz & Security Breach Suite', cmd: 'make test' },
    { id: 'build', label: 'Production Bundle Build Gate', cmd: 'make build' },
  ];

  if (!skipE2e) {
    gates.push({
      id: 'e2eTests',
      label: 'Live Full-Stack Playwright E2E Suite',
      cmd: 'make e2e',
    });
  }

  const results = [];
  for (const gate of gates) {
    const startMs = Date.now();
    const res = spawnSync('bash', ['-c', gate.cmd], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const durationMs = Date.now() - startMs;
    const passed = res.status === 0;
    results.push({
      id: gate.id,
      label: gate.label,
      cmd: gate.cmd,
      passed,
      exitCode: res.status ?? 1,
      durationMs,
      outputTail: `${res.stdout || ''}\n${res.stderr || ''}`
        .trim()
        .split('\n')
        .slice(-12)
        .join('\n'),
    });
    if (!passed) break;
  }

  return {
    ok: results.length === gates.length && results.every((r) => r.passed),
    results,
  };
}

export function buildPersonaDispatchPackets(filterPersonaId = null) {
  const gitCtx = getGitContext();
  const targets = filterPersonaId
    ? PERSONA_REGISTRY.filter((p) => p.id === filterPersonaId)
    : PERSONA_REGISTRY;

  return targets.map((persona) => {
    const absPath = resolve(REPO_ROOT, persona.promptFile);
    const promptBody = existsSync(absPath) ? readFileSync(absPath, 'utf8') : '';
    const composedPrompt = [
      `# Dispatch Packet: ${persona.title} (${persona.id})`,
      `- **Execution Phase:** \`${persona.phase}\``,
      `- **Repository Root:** \`${REPO_ROOT}\``,
      `- **Current Branch / HEAD:** \`${gitCtx.branch}\` (\`${gitCtx.headCommit}\`)`,
      `- **Mandatory Standards:** Read \`${REPO_ROOT}/AGENTS.md\` and \`${REPO_ROOT}/docs/coding-standards.md\` first.`,
      `- **Required Skills to Invoke:** ${persona.skills.map((s) => `\`${s}\``).join(', ')}`,
      `- **Writable Paths:** ${
        persona.writablePaths.length > 0
          ? persona.writablePaths.map((p) => `\`${p}\``).join(', ')
          : '`READ-ONLY (Audit & Report Only)`'
      }`,
      '',
      '## Live Git Context',
      '```text',
      gitCtx.statusShort || '(Clean working tree - inspecting latest commit diff)',
      gitCtx.diffStat,
      '```',
      '',
      promptBody,
    ].join('\n');

    return {
      id: persona.id,
      phase: persona.phase,
      title: persona.title,
      skills: persona.skills,
      writablePaths: persona.writablePaths,
      promptFile: persona.promptFile,
      composedPrompt,
    };
  });
}

export function evaluateQuorumReport(report) {
  const personas = report?.personas ?? {};
  const gates = report?.gatesPassed ?? {};
  const allGatesGreen =
    Boolean(gates.typecheck) &&
    Boolean(gates.migrateVerify) &&
    Boolean(gates.unitTests) &&
    Boolean(gates.build) &&
    Boolean(gates.e2eTests) &&
    Boolean(gates.docsSynced);

  const allFindings = [];
  let shipVotes = 0;

  for (const p of PERSONA_REGISTRY) {
    const pData = personas[p.id];
    if (pData?.vote === 'SHIP') {
      shipVotes++;
    }
    if (Array.isArray(pData?.findings)) {
      for (const f of pData.findings) {
        if (f.status !== 'REJECTED_FALSE_POSITIVE') {
          allFindings.push({ persona: p.id, ...f });
        }
      }
    }
  }

  const verifiedBlockers = allFindings.filter(
    (f) => f.severity === 'CRITICAL' || f.severity === 'HIGH'
  );
  const arbiterVote = personas['fact-checker-arbiter']?.vote ?? 'BLOCK';

  const finalVerdict =
    allGatesGreen &&
    verifiedBlockers.length === 0 &&
    shipVotes >= 3 &&
    arbiterVote === 'SHIP'
      ? 'SHIP'
      : 'BLOCK';

  return {
    finalVerdict,
    allGatesGreen,
    shipVotes,
    totalPersonas: PERSONA_REGISTRY.length,
    arbiterVote,
    verifiedBlockersCount: verifiedBlockers.length,
    verifiedBlockers,
    advisoryFindingsCount: allFindings.length - verifiedBlockers.length,
  };
}

function printHelp() {
  console.log(`Wise-Spliter Multi-Agent Persona Orchestrator
Usage:
  node agents/orchestrate-personas.mjs [options]

Options:
  --phase <check|prompts|gates|evaluate|all>  Phase to execute (default: check)
  --persona <id>                              Filter prompt output to one persona:
                                              test-author-e2e | red-team-hacker |
                                              ux-performance-breaker | fact-checker-arbiter
  --report <path>                             Evaluate a persona quorum JSON report
  --skip-e2e                                  Skip Playwright E2E during --phase gates/all
  --json                                      Output machine-readable JSON
  --help, -h                                  Show this help message`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const fileCheck = validatePersonaFiles();
  if (!fileCheck.ok) {
    console.error('[Orchestrator] Persona specification check failed:', fileCheck.files);
    process.exit(1);
  }

  if (opts.phase === 'check') {
    const packets = buildPersonaDispatchPackets(opts.persona);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, fileCheck, personas: packets.map((p) => ({ id: p.id, phase: p.phase, title: p.title, skills: p.skills, writablePaths: p.writablePaths })) }, null, 2));
    } else {
      console.log('================================================================================');
      console.log('  WISE-SPLITER MULTI-AGENT PERSONA COUNCIL - SPECIFICATION CHECK: PASS');
      console.log('================================================================================');
      for (const f of fileCheck.files) {
        console.log(`  [PASS] ${f.file.padEnd(46)} (${f.lines} lines, ${f.bytes} bytes)`);
      }
      console.log('--------------------------------------------------------------------------------');
      console.log('  Phase A (Dispatch in Parallel):');
      for (const p of packets.filter((x) => x.phase === 'PHASE_A_PARALLEL')) {
        console.log(`    - ${p.id.padEnd(24)} -> ${p.title} [skills: ${p.skills.join(', ')}]`);
      }
      console.log('  Phase B (Sequential Arbiter & Vote Tally):');
      for (const p of packets.filter((x) => x.phase === 'PHASE_B_ARBITER')) {
        console.log(`    - ${p.id.padEnd(24)} -> ${p.title} [skills: ${p.skills.join(', ')}]`);
      }
      console.log('================================================================================');
    }
    process.exit(0);
  }

  if (opts.phase === 'prompts') {
    const packets = buildPersonaDispatchPackets(opts.persona);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, packets }, null, 2));
    } else {
      for (const pkt of packets) {
        console.log('\n' + '='.repeat(80));
        console.log(pkt.composedPrompt);
      }
    }
    process.exit(0);
  }

  if (opts.phase === 'evaluate') {
    if (!opts.reportPath || !existsSync(resolve(REPO_ROOT, opts.reportPath))) {
      console.error('[Orchestrator] --report <valid-json-path> is required for --phase evaluate');
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, opts.reportPath), 'utf8'));
    const evaluation = evaluateQuorumReport(raw);
    console.log(JSON.stringify(evaluation, null, 2));
    process.exit(evaluation.finalVerdict === 'SHIP' ? 0 : 1);
  }

  if (opts.phase === 'gates' || opts.phase === 'all') {
    console.log('[Orchestrator] Running deterministic verification gates...');
    const gateReport = runDeterministicGates({ skipE2e: opts.skipE2e });
    for (const r of gateReport.results) {
      console.log(
        `  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id.padEnd(15)} (${(r.durationMs / 1000).toFixed(2)}s) - ${r.cmd}`
      );
      if (!r.passed) {
        console.error(r.outputTail);
      }
    }
    if (!gateReport.ok) {
      console.error('[Orchestrator] Deterministic gate failed -> Verdict: BLOCK');
      process.exit(1);
    }
    const packets = buildPersonaDispatchPackets(opts.persona);
    console.log(
      `[Orchestrator] All ${gateReport.results.length} gates PASSED. Ready to dispatch ${packets.length} persona agents (` +
        packets.map((p) => p.id).join(', ') +
        ').'
    );
    process.exit(0);
  }

  console.error(`[Orchestrator] Unknown --phase "${opts.phase}". Use --help.`);
  process.exit(1);
}

main();
