/**
 * Checks the specification: the schemas, the examples and the conformance
 * fixtures. It is what CI runs, and it can be run from any directory:
 *
 *     npm test
 *
 * It ends with an exit code other than zero if anything is wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = 'https://spec.jsontemplates.io/schema';
const CONTEXTS = ['block', 'inline', 'horizontal'];

const problems = [];
const problem = (message) => problems.push(message);
const relative = (file) => path.relative(ROOT, file);

/** Reads a JSON file. A file that is not JSON is a problem, not a crash. */
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        problem(`${relative(file)} is not valid JSON: ${error.message}`);

        return null;
    }
}

/** Lists the files of a directory and its subdirectories. */
function walk(directory) {
    if (!fs.existsSync(directory)) {
        return [];
    }

    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);

        return entry.isDirectory() ? walk(full) : [full];
    }).sort();
}

const directories = (directory) => fs.existsSync(directory)
    ? fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];

/** Validates a document and reports what is wrong with it. */
function validates(validate, data, label) {
    if (validate(data)) {
        return true;
    }
    const first = (validate.errors ?? []).slice(0, 3)
        .map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    problem(`${label} does not validate: ${first}`);

    return false;
}

/** The types of the nodes that a template uses. */
function typesOf(value, found = new Set()) {
    if (Array.isArray(value)) {
        value.forEach((item) => typesOf(item, found));
    } else if (value !== null && typeof value === 'object') {
        if (typeof value.type === 'string' && !value.type.includes(':')) {
            found.add(value.type);
        }
        Object.values(value).forEach((item) => typesOf(item, found));
    }

    return found;
}

const wrap = (version, body) => ({ $schema: `${URL_BASE}/${version}/template.json`, body });

/** Version 2.0 and later: JSON Schema 2020-12, one file for each node type. */
function checkSchema(version) {
    const directory = path.join(ROOT, 'schema', version);
    const files = walk(directory).filter((file) => file.endsWith('.json'));
    const schemas = files.map((file) => [file, readJson(file)]).filter(([, schema]) => schema !== null);
    const ajv = new Ajv2020({ strict: true });

    for (const [file, schema] of schemas) {
        const expected = `${URL_BASE}/${version}/${path.relative(directory, file).split(path.sep).join('/')}`;
        if (schema.$id !== expected) {
            problem(`${relative(file)} has $id ${schema.$id}; it must be ${expected}`);
        }
        if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
            problem(`${relative(file)} is not a JSON Schema 2020-12 document`);
        }
        try {
            ajv.addSchema(schema);
        } catch (error) {
            problem(`${relative(file)} can not be added: ${error.message}`);
        }
    }

    let validate = null;
    try {
        validate = ajv.getSchema(`${URL_BASE}/${version}/template.json`);
        if (!validate) {
            problem(`schema/${version}/template.json is missing`);
        }
    } catch (error) {
        problem(`schema/${version} does not compile: ${error.message}`);
    }

    // Every type of node has its file, and the dispatcher of nodes knows it.
    const nodeTypes = files
        .filter((file) => path.dirname(file).endsWith(`${path.sep}nodes`))
        .map((file) => path.basename(file, '.json'));
    const dispatcher = readJson(path.join(directory, 'shared', 'node.json'));
    if (dispatcher) {
        const listed = dispatcher.properties.type.anyOf[0].enum;
        const refs = dispatcher.allOf.map((rule) => rule.then.$ref);
        for (const type of nodeTypes) {
            if (!listed.includes(type)) {
                problem(`shared/node.json does not list the type ${type}`);
            }
            if (!refs.includes(`../nodes/${type}.json`)) {
                problem(`shared/node.json does not refer to nodes/${type}.json`);
            }
        }
        for (const type of listed.filter((name) => !nodeTypes.includes(name))) {
            problem(`shared/node.json lists the type ${type}, which has no file in nodes/`);
        }
    }
    for (const type of nodeTypes) {
        const schema = schemas.find(([file]) => file.endsWith(`${path.sep}nodes${path.sep}${type}.json`))?.[1];
        if (schema?.properties?.type?.const !== type) {
            problem(`nodes/${type}.json does not say that its type is ${type}`);
        }
    }

    return { validate, nodeTypes };
}

/** The examples of a version: each one is a template with at least one data file. */
function checkExamples(version, validate, nodeTypes) {
    const base = path.join(ROOT, 'examples', version);
    const used = new Set();
    const names = directories(base);
    for (const name of names) {
        const dir = path.join(base, name);
        const template = readJson(path.join(dir, 'template.json'));
        if (template !== null && validate) {
            validates(validate, template, `examples/${version}/${name}/template.json`);
            typesOf(template, used);
        }
        const data = fs.readdirSync(dir).filter((file) => file.startsWith('data'));
        if (data.length === 0) {
            problem(`examples/${version}/${name} has no data file`);
        }
        for (const file of data.filter((item) => item.endsWith('.json'))) {
            readJson(path.join(dir, file));
        }
    }
    for (const type of nodeTypes.filter((name) => !used.has(name))) {
        problem(`No example of version ${version} uses the type ${type}`);
    }

    return names;
}

/** The fixtures that every engine uses, which must follow the examples. */
function checkConformance(version, validate, examples) {
    const base = path.join(ROOT, 'conformance', version);
    const expectations = readJson(path.join(base, 'expectations.json')) ?? {};
    const names = Object.keys(expectations).sort();
    if (JSON.stringify(names) !== JSON.stringify(examples)) {
        problem(`conformance/${version}/expectations.json and the examples of ${version} do not have the same names`);
    }
    for (const name of examples) {
        const dir = path.join(ROOT, 'examples', version, name);
        const files = fs.readdirSync(dir).filter((file) => file.startsWith('data')).sort();
        const expected = Object.keys(expectations[name] ?? {}).sort();
        if (JSON.stringify(files) !== JSON.stringify(expected)) {
            problem(`conformance/${version}/expectations.json has the data files ${expected} for ${name}; the example has ${files}`);
        }
        for (const [file, expectation] of Object.entries(expectations[name] ?? {})) {
            const where = `conformance/${version}/expectations.json: ${name}/${file}`;
            const keys = Object.keys(expectation ?? {});
            if (typeof expectation !== 'object' || expectation === null || keys.some((key) => !['contains', 'absent'].includes(key))) {
                problem(`${where} must be an object with contains and, optionally, absent`);
                continue;
            }
            const lists = { contains: expectation.contains, absent: expectation.absent ?? [] };
            for (const [key, list] of Object.entries(lists)) {
                if (!Array.isArray(list) || list.some((text) => typeof text !== 'string' || text === '') || (key === 'contains' && list.length === 0)) {
                    problem(`${where}: ${key} must be a list of texts`);
                }
            }
            if (Array.isArray(lists.contains) && lists.absent.some((text) => lists.contains.some((other) => other.includes(text)))) {
                problem(`${where}: a text of absent is in a text of contains`);
            }
        }
        if (!fs.existsSync(path.join(base, 'twig', 'compiled', `${name}.html.twig`))) {
            problem(`conformance/${version}/twig/compiled/${name}.html.twig is missing`);
        }
    }
    for (const file of walk(path.join(base, 'twig', 'compiled'))) {
        if (!examples.includes(path.basename(file, '.html.twig'))) {
            problem(`${relative(file)} does not belong to an example`);
        }
    }

    for (const file of walk(path.join(base, 'formats'))) {
        const name = path.basename(file, '.json');
        const table = readJson(file) ?? {};
        const where = relative(file);
        if (table.format !== name) {
            problem(`${where}: format must be ${name}`);
        }
        if (!Array.isArray(table.cases) || table.cases.length === 0
            || table.cases.some((entry) => !('value' in entry) || typeof entry.text !== 'string')) {
            problem(`${where}: cases must be a list of objects with value and text`);
        }
        if ('invalid' in table && !Array.isArray(table.invalid)) {
            problem(`${where}: invalid must be a list`);
        }
        if (Object.keys(table).some((key) => !['format', 'cases', 'invalid'].includes(key))) {
            problem(`${where}: it has keys other than format, cases and invalid`);
        }
    }

    const scenarios = readJson(path.join(base, 'twig', 'node-scenarios.json')) ?? {};
    for (const [name, scenario] of Object.entries(scenarios)) {
        if (!CONTEXTS.includes(scenario.context) || typeof scenario.expected !== 'string') {
            problem(`conformance/${version}/twig/node-scenarios.json: ${name} has a wrong context or no expected text`);
        }
        validates(validate, wrap(version, scenario.node), `conformance/${version}/twig/node-scenarios.json: ${name}`);
    }

    const invalid = walk(path.join(base, 'invalid')).filter((file) => file.endsWith('.json'));
    if (invalid.length === 0) {
        problem(`conformance/${version}/invalid has no templates`);
    }
    for (const file of invalid) {
        const template = readJson(file);
        if (template !== null && validate(template)) {
            problem(`${relative(file)} must be rejected by the schema, and it is valid`);
        }
    }
}

/** Version 1.0: JSON Schema draft-07, and the examples of its website. */
function checkFirstVersion() {
    const file = path.join(ROOT, 'schema', '1.0', 'template.json');
    const schema = readJson(file);
    if (schema === null) {
        return;
    }
    const url = `${URL_BASE}/1.0/template.json`;
    if (schema.$id !== url) {
        problem(`schema/1.0/template.json has $id ${schema.$id}; it must be ${url}`);
    }
    const ajv = new Ajv({ strict: false, validateFormats: false });
    let validate;
    try {
        validate = ajv.compile(schema);
    } catch (error) {
        problem(`schema/1.0/template.json does not compile: ${error.message}`);

        return;
    }
    for (const example of walk(path.join(ROOT, 'examples', '1.0')).filter((item) => item.includes(`${path.sep}templates${path.sep}`) && item.endsWith('.json'))) {
        const template = readJson(example);
        if (template !== null) {
            validates(validate, template, relative(example));
            if (template.$schema !== undefined && template.$schema !== url) {
                problem(`${relative(example)} has $schema ${template.$schema}; it must be ${url}`);
            }
        }
    }
}

/** The relative links of the Markdown files must lead somewhere. */
function checkLinks() {
    const files = walk(ROOT).filter((file) => file.endsWith('.md') && !file.includes(`${path.sep}node_modules${path.sep}`));
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
            if (/^[a-z]+:|^#/.test(target)) {
                continue;
            }
            const clean = target.split('#')[0];
            if (clean !== '' && !fs.existsSync(path.resolve(path.dirname(file), clean))) {
                problem(`${relative(file)} links to ${target}, which does not exist`);
            }
        }
    }
}

const versions = directories(path.join(ROOT, 'schema')).filter((version) => version !== '1.0');
for (const version of versions) {
    const { validate, nodeTypes } = checkSchema(version);
    const examples = checkExamples(version, validate, nodeTypes);
    if (validate && fs.existsSync(path.join(ROOT, 'conformance', version))) {
        checkConformance(version, validate, examples);
    }
}
checkFirstVersion();
checkLinks();

if (problems.length > 0) {
    console.error(problems.map((message) => `- ${message}`).join('\n'));
    console.error(`\n${problems.length} problem(s).`);
    process.exit(1);
}
console.log(`OK: schemas ${[...versions, '1.0'].join(', ')}, their examples and the conformance fixtures.`);
