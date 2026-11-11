import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const configPath = path.join(projectRoot, 'tsconfig.json');

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(
    '[check-deprecations] Failed to read tsconfig.json:',
    ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n')
  );
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  projectRoot
);

const files = parsedConfig.fileNames;

const servicesHost = {
  getScriptFileNames: () => files,
  getScriptVersion: () => '1',
  getScriptSnapshot: (fileName) => {
    if (!fs.existsSync(fileName)) return undefined;
    return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
  },
  getCurrentDirectory: () => projectRoot,
  getCompilationSettings: () => parsedConfig.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};

const languageService = ts.createLanguageService(
  servicesHost,
  ts.createDocumentRegistry()
);

const deprecatedDiagnostics = [];

for (const file of files) {
  const suggestionDiagnostics = languageService.getSuggestionDiagnostics(file);
  for (const d of suggestionDiagnostics) {
    if (d.reportsDeprecated || d.code === 6385 || d.code === 6387) {
      const { line, character } = d.file
        ? d.file.getLineAndCharacterOfPosition(d.start ?? 0)
        : { line: 0, character: 0 };
      const relPath = path.relative(projectRoot, file);
      const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
      deprecatedDiagnostics.push(
        `${relPath}:${line + 1}:${character + 1} - [TS${d.code}] ${message}`
      );
    }
  }
}

if (deprecatedDiagnostics.length > 0) {
  console.error(
    `[check-deprecations] FAIL - Found ${deprecatedDiagnostics.length} deprecated diagnostic(s):`
  );
  for (const item of deprecatedDiagnostics) {
    console.error(`  ${item}`);
  }
  process.exit(1);
}

console.log(
  `[check-deprecations] PASS - 0 deprecated APIs or symbols found across ${files.length} files.`
);
