import { DirectoryContext } from '@cmt/workspace';
import * as path from 'path';
import * as vscode from 'vscode';
import * as xml2js from 'xml2js';
import * as zlib from 'zlib';

import { CMakeDriver } from '@cmt/drivers/drivers';
import * as logging from './logging';
import { fs } from './pr';
import { OutputConsumer } from './proc';
import * as util from './util';
import * as nls from 'vscode-nls';
import { testArgs, TestPreset } from './preset';
import { expandString } from './expand';
import * as proc from '@cmt/proc';
import { ProjectController } from './projectController';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = logging.createLogger('ctest');

const magicKey = 'ctest.magic.key';
// Used as magic value
let sessionNum= 0;

// Placeholder in the test explorer when test preset is not selected
const testPresetRequired = '_test_preset_required_';

interface SiteAttributes {}

type TestStatus = ('failed' | 'notrun' | 'passed');

export interface TestMeasurement {
    type: string;
    name: string;
    value: any;
}

export interface Test {
    status: TestStatus;
    fullCommandLine: string;
    fullName: string;
    name: string;
    path: string;
    measurements: Map<string, TestMeasurement>;
    output: string;
}

export interface TestingData {
    // Fill out when we need all the attributes
    testList: string[];
    test: Test[];
}

export interface SiteData {
    $: SiteAttributes;
    testing: TestingData;
}

export interface CTestResults { site: SiteData }

interface EncodedMeasurementValue {
    $: { encoding?: BufferEncoding; compression?: string };
    _: string;
}

interface MessyResults {
    Site: {
        $: {};
        Testing: {
            TestList: { Test: string[] }[];
            EndDateTime: string[];
            EndTestTime: string[];
            ElapsedMinutes: string[];
            Test: {
                $: { Status: TestStatus };
                FullCommandLine: string[];
                FullName: string[];
                Name: string[];
                Path: string[];
                Results: {
                    NamedMeasurement:
                    { $: { type: string; name: string }; Value: string[] }[];
                    Measurement: { Value: [EncodedMeasurementValue | string] }[];
                }[];
            }[];
        }[];
    };
}

interface CTestInfo {
    backtraceGraph: {
        commands: string[];
        files: string[];
        nodes: {
            file: number;
            command?: number;
            line?: number;
            parent?: number;
        }[];
    };
    kind: string; // ctestInfo
    tests: {
        backtrace: number;
        command: string[];
        name: string;
        properties: { name: string; value: string | string[] }[];
    }[];
    version: { major: number; minor: number };
}

function parseXmlString<T>(xml: string): Promise<T> {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xml, (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

function decodeOutputMeasurement(node: EncodedMeasurementValue | string): string {
    if (typeof node === 'string') {
        return node;
    }
    let buffer = !!node.$.encoding ? Buffer.from(node._, node.$.encoding) : Buffer.from(node._, 'utf-8');
    if (!!node.$.compression) {
        buffer = zlib.unzipSync(buffer);
    }
    return buffer.toString('utf-8');
}

function cleanupResultsXml(messy: MessyResults): CTestResults {
    const testingHead = messy.Site.Testing[0];
    if (testingHead.TestList.length === 1 && (testingHead.TestList[0] as any as string) === '') {
        // XML parsing is obnoxious. This condition means that there are no tests,
        // but CTest is still enabled.
        return {
            site: {
                $: messy.Site.$,
                testing: {
                    testList: [],
                    test: []
                }
            }
        };
    }
    return {
        site: {
            $: messy.Site.$,
            testing: {
                testList: testingHead.TestList[0].Test,
                test: testingHead.Test.map((test): Test => {
                    const measurements = new Map<string, TestMeasurement>();
                    for (const namedMeasurement of test.Results[0].NamedMeasurement) {
                        measurements.set(namedMeasurement.$.name, {
                            type: namedMeasurement.$.type,
                            name: namedMeasurement.$.name,
                            value: decodeOutputMeasurement(namedMeasurement.Value[0])
                        });
                    }
                    return {
                        fullName: test.FullName[0],
                        fullCommandLine: test.FullCommandLine[0],
                        name: test.Name[0],
                        path: test.Path[0],
                        status: test.$.Status,
                        measurements,
                        output: decodeOutputMeasurement(test.Results[0].Measurement[0].Value[0])
                    };
                })
            }
        }
    };
}

export async function readTestResultsFile(testXml: string): Promise<CTestResults | undefined> {
    try {
        const content = (await fs.readFile(testXml)).toString();
        const data = await parseXmlString(content) as MessyResults;
        const clean = cleanupResultsXml(data);
        return clean;
    } catch {
        return undefined;
    }
}

class CTestOutputLogger implements OutputConsumer {
    output(line: string) {
        log.info(line);
    }
    error(line: string) {
        this.output(line);
    }
}

export class CTestDriver implements vscode.Disposable {
    /**
     * @param projectController Required for test explorer to work properly. Setting as optional to avoid breaking tests.
     */
    constructor(readonly ws: DirectoryContext, private readonly projectController?: ProjectController) {}

    private _testingEnabled: boolean = false;
    get testingEnabled(): boolean {
        return this._testingEnabled;
    }
    set testingEnabled(v: boolean) {
        this._testingEnabled = v;
        this.testingEnabledEmitter.fire(v);
    }

    private readonly testingEnabledEmitter = new vscode.EventEmitter<boolean>();
    readonly onTestingEnabledChanged = this.testingEnabledEmitter.event;

    dispose() {
        this.testingEnabledEmitter.dispose();
        this.testsChangedEmitter.dispose();
    }

    /**
     * Holds the most recent test informations
     */
    private _tests: CTestInfo | undefined;
    get tests(): CTestInfo | undefined {
        return this._tests;
    }
    set tests(v: CTestInfo | undefined) {
        this._tests = v;
        this.testsChangedEmitter.fire(v);
    }

    private readonly testsChangedEmitter = new vscode.EventEmitter<CTestInfo | undefined>();
    readonly onTestsChanged = this.testsChangedEmitter.event;

    private testItemCollectionToArray(collection: vscode.TestItemCollection): vscode.TestItem[] {
        if (!collection) {
            return [];
        }
        const items: vscode.TestItem[] = [];
        collection.forEach(item => items.push(item));
        return items;
    };

    private async getCTestArgs(driver: CMakeDriver, customizedTask: boolean = false, testPreset?: TestPreset): Promise<string[] | undefined> {
        let ctestArgs: string[];
        if (customizedTask && testPreset) {
            ctestArgs = ['-T', 'test'].concat(testArgs(testPreset));
        } else if (!customizedTask && driver.useCMakePresets) {
            if (!driver.testPreset) {
                // Test explorer doesn't handle errors well, so we need to deal with them ourselves
                return undefined;
            }
            // Add a few more args so we can show the result in status bar
            ctestArgs = ['-T', 'test'].concat(testArgs(driver.testPreset));
        } else {
            const configuration = driver.currentBuildType;
            const opts = driver.expansionOptions;
            const jobs = await expandString(this.ws.config.numCTestJobs, opts);
            const defaultArgs = [];
            for (const value of this.ws.config.ctestDefaultArgs) {
                defaultArgs.push(await expandString(value, opts));
            }
            const args = [];
            for (const value of this.ws.config.ctestArgs) {
                args.push(await expandString(value, opts));
            }
            ctestArgs = [`-j${jobs}`, '-C', configuration].concat(defaultArgs, args);
        }
        return ctestArgs;
    }

    public async runCTest(driver: CMakeDriver, customizedTask: boolean = false, testPreset?: TestPreset, consumer?: proc.OutputConsumer): Promise<number> {
        if (!customizedTask) {
            // We don't want to focus on log channel when running tasks.
            log.showChannel();
        }

        if (!testExplorer) {
            await this.refreshTests(driver);
        }

        if (!testExplorer) {
            log.info(localize('no.tests.found', 'No tests found'));
            return -1;
        } else if (!this.ws.config.ctestAllowParallelJobs) {
            const tests = this.testItemCollectionToArray(testExplorer.items);
            const run = testExplorer.createTestRun(new vscode.TestRunRequest());
            const ctestArgs = await this.getCTestArgs(driver, customizedTask, testPreset);
            const returnCode = await this.runCTestHelper(tests, run, driver, undefined, ctestArgs, undefined, customizedTask, consumer);
            run.end();
            return returnCode;
        } else {
            // below code taken from #3032 PR (before changes in how tests are run)
            const ctestpath = await this.ws.getCTestPath(driver.cmakePathFromPreset);
            if (ctestpath === null) {
                log.info(localize('ctest.path.not.set', 'CTest path is not set'));
                return -2;
            }

            let ctestArgs: string[];
            if (customizedTask && testPreset) {
                ctestArgs = ['-T', 'test'].concat(testArgs(testPreset));
            } else if (!customizedTask && driver.useCMakePresets) {
                if (!driver.testPreset) {
                    log.error(localize('test.preset.not.set', 'Test preset is not set'));
                    return -3;
                }
                // Add a few more args so we can show the result in status bar
                ctestArgs = ['-T', 'test'].concat(testArgs(driver.testPreset));
            } else {
                const configuration = driver.currentBuildType;
                const opts = driver.expansionOptions;
                const jobs = await expandString(this.ws.config.numCTestJobs, opts);
                const defaultArgs = [];
                for (const value of this.ws.config.ctestDefaultArgs) {
                    defaultArgs.push(await expandString(value, opts));
                }
                const args = [];
                for (const value of this.ws.config.ctestArgs) {
                    args.push(await expandString(value, opts));
                }
                ctestArgs = [`-j${jobs}`, '-C', configuration].concat(defaultArgs, args);
            }

            const child = driver.executeCommand(
                ctestpath,
                ctestArgs,
                ((customizedTask && consumer) ? consumer : new CTestOutputLogger()),
                { environment: await driver.getCTestCommandEnvironment(), cwd: driver.binaryDir });
            const res = await child.result;
            // not sure if direct comparison can be made to replace reloadTests with refreshTests
            await this.refreshTests(driver);
            if (res.retc === null) {
                log.info(localize('ctest.run.terminated', 'CTest run was terminated'));
                return -1;
            } else {
                log.info(localize('ctest.finished.with.code', 'CTest finished with return code {0}', res.retc));
            }
            return res.retc;
        }
    }

    private ctestsEnqueued(tests: vscode.TestItem[], run: vscode.TestRun) {
        for (const test of tests) {
            if (test.children.size > 0) {
                const children = this.testItemCollectionToArray(test.children);
                this.ctestsEnqueued(children, run);
            } else {
                run.enqueued(test);
            }
        }
    }

    private ctestErrored(test: vscode.TestItem, run: vscode.TestRun, message: vscode.TestMessage): void {
        if (test.children.size > 0) {
            const children = this.testItemCollectionToArray(test.children);
            for (const child of children) {
                this.ctestErrored(child, run, message);
            }
        } else {
            if (test.uri && test.range) {
                message.location = new vscode.Location(test.uri, test.range);
            } else {
                log.error(message.message);
            }
            run.errored(test, message);
        }
    }

    private ctestFailed(test: vscode.TestItem, run: vscode.TestRun, message: vscode.TestMessage, duration?: number): void {
        if (test.uri && test.range) {
            message.location = new vscode.Location(test.uri, test.range);
        } else {
            log.info(message);
        }
        run.failed(test, message, duration);
    }

    private async runCTestHelper(tests: vscode.TestItem[], run: vscode.TestRun, driver?: CMakeDriver, ctestPath?: string, ctestArgs?: string[], cancellation?: vscode.CancellationToken, customizedTask: boolean = false, consumer?: proc.OutputConsumer): Promise<number> {
        let returnCode: number = 0;
        for (const test of tests) {
            if (cancellation && cancellation.isCancellationRequested) {
                run.skipped(test);
                continue;
            }

            let _driver: CMakeDriver | null;
            if (driver) {
                _driver = driver;
            } else {
                const folder = test.parent ? test.parent.id : test.id;
                const project = await this.projectController?.getProjectForFolder(folder);
                if (!project) {
                    this.ctestErrored(test, run, { message: localize('no.project.found', 'No project found for folder {0}', folder) });
                    continue;
                }
                _driver = await project.getCMakeDriverInstance();
                if (!_driver) {
                    this.ctestErrored(test, run, { message: localize('no.driver.found', 'No driver found for folder {0}', folder) });
                    continue;
                }
            }

            let _ctestPath: string | null;
            if (ctestPath) {
                _ctestPath = ctestPath;
            } else {
                _ctestPath = await this.ws.getCTestPath(_driver.cmakePathFromPreset);
                if (_ctestPath === null) {
                    this.ctestErrored(test, run, { message: localize('ctest.path.not.set', 'CTest path is not set') });
                    continue;
                }
            }

            let _ctestArgs: string[] | undefined;
            if (ctestArgs) {
                _ctestArgs = ctestArgs;
            } else {
                _ctestArgs = await this.getCTestArgs(_driver, customizedTask);
            }

            if (!_ctestArgs) {
                this.ctestErrored(test, run, { message: localize('ctest.args.not.found', 'Could not get test arguments') });
                continue;
            }

            if (test.children.size > 0) {
                // Shouldn't reach here now, but not hard to write so keeping it in case we want to have more complicated test hierarchies
                const children = this.testItemCollectionToArray(test.children);
                if (await this.runCTestHelper(children, run, _driver, _ctestPath, _ctestArgs, cancellation, customizedTask, consumer)) {
                    returnCode = -1;
                }
            } else {
                run.started(test);

                const testResults = await this.runCTestImpl(_driver, _ctestPath, _ctestArgs, test.id, customizedTask, consumer);

                let foundTestResult = false;
                // Only show the first failure
                let havefailures = false;
                let duration: number | undefined;
                if (testResults) {
                    for (let i = 0; i < testResults.site.testing.test.length; i++) {
                        const testName = testResults.site.testing.test[i].name;
                        if (testName === test.id) {
                            foundTestResult = true;
                            const durationStr = testResults.site.testing.test[i].measurements.get("Execution Time")?.value;
                            duration = durationStr ? parseFloat(durationStr) * 1000 : undefined;
                        }

                        let output = testResults.site.testing.test[i].output;
                        if (process.platform === 'win32') {
                            output = output.replace(/\r?\n/g, '\r\n');
                        }
                        run.appendOutput(output);

                        if (testResults.site.testing.test[i].status !== 'passed' && !havefailures) {
                            const failureDurationStr = testResults.site.testing.test[i].measurements.get("Execution Time")?.value;
                            const failureDuration = failureDurationStr ? parseFloat(failureDurationStr) * 1000 : undefined;
                            const exitCode = testResults.site.testing.test[i].measurements.get("Exit Value")?.value;
                            const completionStatus = testResults.site.testing.test[i].measurements.get("Completion Status")?.value;

                            if (exitCode !== undefined) {
                                this.ctestFailed(
                                    test,
                                    run,
                                    new vscode.TestMessage(localize('test.failed.with.exit.code', 'Test {0} failed with exit code {1}.', testName, exitCode)),
                                    failureDuration
                                );
                            } else if (completionStatus !== undefined) {
                                this.ctestErrored(
                                    test,
                                    run,
                                    new vscode.TestMessage(localize('test.failed.with.completion.status', 'Test {0} failed with completion status "{1}".', testName, completionStatus))
                                );
                            } else {
                                this.ctestErrored(
                                    test,
                                    run,
                                    new vscode.TestMessage(localize('test.failed', 'Test {0} failed. Please check output for more information.', testName))
                                );
                            }

                            havefailures = true;
                            returnCode = -1;
                        }
                    }
                }

                if (!foundTestResult && !havefailures) {
                    this.ctestFailed(test, run, new vscode.TestMessage(localize('test.results.not.found', 'Test results not found.')));
                    havefailures = true;
                    returnCode = -1;
                }

                if (!havefailures) {
                    run.passed(test, duration);
                }
            }
        }

        return returnCode;
    };

    private async runCTestImpl(driver: CMakeDriver, ctestPath: string, ctestArgs: string[], testName: string, customizedTask: boolean = false, consumer?: proc.OutputConsumer): Promise<CTestResults | undefined> {
        const child = driver.executeCommand(
            ctestPath,
            ctestArgs.concat('-R', `^${util.escapeStringForRegex(testName)}\$`),
            ((customizedTask && consumer) ? consumer : new CTestOutputLogger()),
            { environment: await driver.getCTestCommandEnvironment(), cwd: driver.binaryDir });
        const res = await child.result;
        if (res.retc === null) {
            log.info(localize('ctest.run.terminated', 'CTest run was terminated'));
        } else {
            log.info(localize('ctest.finished.with.code', 'CTest finished with return code {0}', res.retc));
        }

        const tagFile = path.join(driver.binaryDir, 'Testing', 'TAG');
        const tag = (await fs.exists(tagFile)) ? (await fs.readFile(tagFile)).toString().split('\n')[0].trim() : null;
        const tagDir = tag ? path.join(driver.binaryDir, 'Testing', tag) : null;
        const resultsFile = tagDir ? path.join(tagDir, 'Test.xml') : null;
        if (resultsFile && await fs.exists(resultsFile)) {
            // TODO: Should we handle the case where resultsFiles doesn't exist?
            console.assert(tagDir);
            return readTestResultsFile(resultsFile);
        }

        return undefined;
    }

    /**
     * @brief Refresh the list of CTest tests
     * @returns 0 when successful
     */
    async refreshTests(driver: CMakeDriver): Promise<number> {
        if (util.isTestMode()) {
            // ProjectController can't be initialized in test mode, so we don't have a usable test explorer
            return 0;
        }

        const initializedTestExplorer = this.ensureTestExplorerInitialized();
        const sourceDir = util.platformNormalizePath(driver.sourceDir);
        const testExplorerRoot = initializedTestExplorer.items.get(sourceDir);
        if (!testExplorerRoot) {
            log.error(localize('folder.not.found.in.test.explorer', 'Folder is not found in Test Explorer: {0}', sourceDir));
            return -1;
        }
        // Clear all children and re-add later
        testExplorerRoot.children.replace([]);

        // TODO: There's no way to mark tests as outdated now.
        const ctestFile = path.join(driver.binaryDir, 'CTestTestfile.cmake');
        if (!(await fs.exists(ctestFile))) {
            this.testingEnabled = false;
            return -1;
        }
        this.testingEnabled = true;

        const ctestpath = await this.ws.getCTestPath(driver.cmakePathFromPreset);
        if (ctestpath === null) {
            log.info(localize('ctest.path.not.set', 'CTest path is not set'));
            return -2;
        }

        const ctestArgs = await this.getCTestArgs(driver);
        if (!ctestArgs) {
            // Happens when testPreset is not selected
            const testItem = initializedTestExplorer.createTestItem(testPresetRequired, localize('test.preset.required', 'Select a test preset to discover tests'));
            testExplorerRoot.children.add(testItem);
            return 0;
        }
        if (!driver.cmake.version || util.versionLess(driver.cmake.version, { major: 3, minor: 14, patch: 0 })) {
            // ctest --show-only=json-v1 was added in CMake 3.14
            const result = await driver.executeCommand(ctestpath, ['-N', ...ctestArgs], undefined, { cwd: driver.binaryDir, silent: true }).result;
            if (result.retc !== 0) {
                // There was an error running CTest. Odd...
                log.error(localize('ctest.error', 'There was an error running ctest to determine available test executables'));
                return result.retc || -3;
            }
            const tests = result.stdout?.split('\n')
                .map(l => l.trim())
                .filter(l => /^Test\s*#(\d+):\s(.*)/.test(l))
                .map(l => /^Test\s*#(\d+):\s(.*)/.exec(l)!)
                .map(([, id, tname]) => ({ id: parseInt(id!), name: tname! })) ?? [];

            // Add tests to the test explorer
            for (const test of tests) {
                testExplorerRoot.children.add(initializedTestExplorer.createTestItem(test.name, test.name));
            }
        } else {
            const result = await driver.executeCommand(ctestpath, ['--show-only=json-v1', ...ctestArgs], undefined, { cwd: driver.binaryDir, silent: true }).result;
            if (result.retc !== 0) {
                // There was an error running CTest. Odd...
                log.error(localize('ctest.error', 'There was an error running ctest to determine available test executables'));
                return result.retc || -3;
            }
            this.tests = JSON.parse(result.stdout) ?? undefined;
            if (this.tests && this.tests.kind === 'ctestInfo') {
                this.tests.tests.forEach(test => {
                    let testItem: vscode.TestItem;
                    if (test.backtrace !== undefined && this.tests!.backtraceGraph.nodes[test.backtrace] !== undefined) {
                        const testDefFile = this.tests!.backtraceGraph.files[this.tests!.backtraceGraph.nodes[test.backtrace].file];
                        const testDefLine = this.tests!.backtraceGraph.nodes[test.backtrace].line;
                        testItem = initializedTestExplorer.createTestItem(test.name, test.name, vscode.Uri.file(testDefFile));
                        if (testDefLine !== undefined) {
                            testItem.range = new vscode.Range(new vscode.Position(testDefLine - 1, 0), new vscode.Position(testDefLine - 1, 0));
                        }
                    } else {
                        testItem = initializedTestExplorer.createTestItem(test.name, test.name);
                    }

                    const testTags: vscode.TestTag[] = [];
                    if (test.properties) {
                        for (const property of test.properties) {
                            if (property.name === "LABELS") {
                                if (util.isString(property.value)) {
                                    testTags.push(new vscode.TestTag(property.value));
                                } else {
                                    testTags.push(...property.value.map(v => new vscode.TestTag(v)));
                                }
                            }
                        }
                    }

                    if (testTags.length !== 0) {
                        testItem.tags = [...testItem.tags, ...testTags];
                    }

                    testExplorerRoot.children.add(testItem);
                });
            };
        }

        return 0;
    }

    clearTests(driver: CMakeDriver) {
        if (!testExplorer) {
            return;
        }
        const sourceDir = util.platformNormalizePath(driver.sourceDir);
        const testExplorerRoot = testExplorer.items.get(sourceDir);
        if (!testExplorerRoot) {
            log.error(localize('folder.not.found.in.test.explorer', 'Folder is not found in Test Explorer: {0}', sourceDir));
            return;
        }
        testExplorerRoot.children.replace([]);
    }

    /**
     * Filters out duplicate tests, i.e., both the parent and child are requested
     */
    private uniqueTests(tests: readonly vscode.TestItem[]): vscode.TestItem[] {
        const parents = new Set<string>();
        tests.forEach(t => {
            if (!t.parent) {
                parents.add(t.id);
            }
        });
        const uniqueTests: vscode.TestItem[] = [];
        tests.forEach(t => {
            if (!t.parent || !parents.has(t.parent.id)) {
                uniqueTests.push(t);
            }
        });
        return uniqueTests;
    }

    /**
     * This function checks if tests require test presets already have a test preset selected.
     * Check is done by looking for magic test item testPresetRequired. When test preset is not selected, there will
     * be one and only one such test item under that folder.
     * When test preset is not selected, this function will prompt for test preset selection. Changing test preset triggers
     * test explorer refresh.
     *
     * Returns false if any test preset wasn't selected already. This means either test explorer is going to be refreshed,
     * or user cancelled the selection. So we shouldn't proceed in most cases.
     */
    private async checkTestPreset(tests: vscode.TestItem[]): Promise<boolean> {
        let presetMayChange = false;
        for (const test of tests) {
            if (test.id === testPresetRequired) {
                const folder = test.parent ? test.parent.id : test.id;
                const project = await this.projectController?.getProjectForFolder(folder);
                if (!project) {
                    log.error(localize('no.project.found', 'No project found for folder {0}', folder));
                    return false;
                }
                await vscode.commands.executeCommand('cmake.selectTestPreset', project.workspaceFolder);
                presetMayChange = true;
            }
        }

        if (presetMayChange) {
            return false;
        }
        return true;
    }

    private async runTestHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
        if (!testExplorer) {
            return;
        }

        const requestedTests = request.include || this.testItemCollectionToArray(testExplorer.items);
        const tests = this.uniqueTests(requestedTests);

        if (!await this.checkTestPreset(tests)) {
            return;
        }

        const run = testExplorer.createTestRun(request);
        this.ctestsEnqueued(tests, run);
        await this.buildTests(tests, run);
        await this.runCTestHelper(tests, run, undefined, undefined, undefined, cancellation);
        run.end();
    };

    private async debugCTestHelper(tests: vscode.TestItem[], run: vscode.TestRun, cancellation: vscode.CancellationToken): Promise<number> {
        let returnCode: number = 0;

        if (!await this.checkTestPreset(tests)) {
            return -2;
        }

        for (const test of tests) {
            if (cancellation && cancellation.isCancellationRequested) {
                run.skipped(test);
                continue;
            }

            const folder = test.parent ? test.parent.id : test.id;
            const project = await this.projectController?.getProjectForFolder(folder);
            if (!project) {
                this.ctestErrored(test, run, { message: localize('no.project.found', 'No project found for folder {0}', folder) });
                continue;
            }
            const workspaceFolder = project.workspaceFolder;

            if (test.children.size > 0) {
                // Shouldn't reach here now, but not hard to write so keeping it in case we want to have more complicated test hierarchies
                const children = this.testItemCollectionToArray(test.children);
                if (await this.debugCTestHelper(children, run, cancellation)) {
                    returnCode = -1;
                }
            } else {
                run.started(test);
                await this.debugCTestImpl(workspaceFolder, test.id, cancellation);
                // We have no way to get the result, so just mark it as skipped
                run.skipped(test);
            }
        }
        return returnCode;
    }

    private async debugCTestImpl(workspaceFolder: vscode.WorkspaceFolder, testName: string, cancellation: vscode.CancellationToken): Promise<void> {
        const magicValue = sessionNum++;

        const testProgram = this.testProgram(testName);
        const basename = path.parse(testProgram).name;
        const debugConfig = await this.projectController?.getActiveCMakeProject()?.getDebugConfiguration(basename);

        if (debugConfig === null || debugConfig === undefined) {
            log.error(localize('no.launch.config', 'No launch configurations found.'));
            return;
        }

        debugConfig.cwd = this.testWorkingDirectory(testName)!;
        debugConfig.args = this.testArgs(testName)!;

        // Identify the session we started
        debugConfig[magicKey] = magicValue;

        let onDidStartDebugSession: vscode.Disposable | undefined;
        let onDidTerminateDebugSession: vscode.Disposable | undefined;
        let sessionId: string | undefined;
        const started = new Promise<vscode.DebugSession>(resolve => {
            onDidStartDebugSession = vscode.debug.onDidStartDebugSession((session: vscode.DebugSession) => {
                if (session.configuration[magicKey] === magicValue) {
                    sessionId = session.id;
                    resolve(session);
                }
            });
        });

        const terminated = new Promise<void>(resolve => {
            onDidTerminateDebugSession = vscode.debug.onDidTerminateDebugSession((session: vscode.DebugSession) => {
                if (session.id === sessionId) {
                    resolve();
                }
            });
        }).finally(() => {
            log.info('debugSessionTerminated');
        });

        const debugStarted = await vscode.debug.startDebugging(workspaceFolder, debugConfig!);
        if (debugStarted) {
            const session = await started;
            if (session) {
                cancellation.onCancellationRequested(() => {
                    void vscode.debug.stopDebugging(session);
                });
            }
            await terminated;
            if (onDidStartDebugSession) {
                onDidStartDebugSession.dispose();
            }
            if (onDidTerminateDebugSession) {
                onDidTerminateDebugSession.dispose();
            }
        }
    }

    private testProgram(testName: string): string {
        if (this.tests) {
            for (const test of this.tests.tests) {
                if (test.name === testName) {
                    return test.command[0];
                }
            }
        }
        return '';
    }

    private testWorkingDirectory(testName: string): string {
        const property = this.tests?.tests
            .find(test => test.name === testName)?.properties
            .find(prop => prop.name === 'WORKING_DIRECTORY');

        if (typeof(property?.value) === 'string') {
            return property.value;
        }
        return '';
    }

    private testArgs(testName: string): string[] {
        if (this.tests) {
            for (const test of this.tests.tests) {
                if (test.name === testName) {
                    return test.command.slice(1);
                }
            }
        }
        return [];
    }

    private async debugTestHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
        if (!testExplorer) {
            return;
        }

        const requestedTests = request.include || this.testItemCollectionToArray(testExplorer.items);
        const tests = this.uniqueTests(requestedTests);

        const run = testExplorer.createTestRun(request);
        this.ctestsEnqueued(tests, run);
        await this.buildTests(tests, run);
        await this.debugCTestHelper(tests, run, cancellation);
        run.end();
    };

    private async buildTests(tests: vscode.TestItem[], run: vscode.TestRun) {
        // Folder => status
        const builtFolder = new Map<string, number>();
        let status: number = 0;
        for (const test of tests) {
            const folder = test.parent ? test.parent.id : test.id;
            if (!builtFolder.has(folder)) {
                const project = await this.projectController?.getProjectForFolder(folder);
                if (!project) {
                    status = 1;
                } else {
                    try {
                        const buildResult = await project.build(undefined, false, false);
                        if (buildResult !== 0) {
                            status = 2;
                        }
                    } catch (e) {
                        status = 2;
                    }
                }
            }
            builtFolder.set(folder, status);
            if (status === 1) {
                this.ctestErrored(test, run, { message: localize('no.project.found', 'No project found for folder {0}', folder) });
            } else if (status === 2) {
                this.ctestErrored(test, run, { message: localize('build.failed', 'Build failed') });
            }
        }
    }

    /**
     * Initializes the VS Code Test Controller if it is not already initialized.
     * Should only be called by refreshTests since it adds tests to the controller.
     */
    private ensureTestExplorerInitialized(): vscode.TestController {
        if (!testExplorer) {
            testExplorer = vscode.tests.createTestController('cmake-tools.CTest', 'CTest');

            // Cast to any since this is not supported yet in the API we use.
            (testExplorer as any).refreshHandler = () => vscode.commands.executeCommand('cmake.refreshTestsAll');

            if (this.projectController) {
                for (const project of this.projectController.getAllCMakeProjects()) {
                    const folderPath = util.platformNormalizePath(project.sourceDir);
                    const folderName = path.basename(project.sourceDir);
                    const testItem = testExplorer.createTestItem(folderPath, folderName);
                    testItem.description = folderPath;
                    testExplorer.items.add(testItem);
                }
            }

            testExplorer.createRunProfile(
                'Run Tests',
                vscode.TestRunProfileKind.Run,
                (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => this.runTestHandler(request, cancellation),
                true
            );
            testExplorer.createRunProfile(
                'Debug Tests',
                vscode.TestRunProfileKind.Debug,
                (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => this.debugTestHandler(request, cancellation));
        }
        return testExplorer;
    }

    addTestExplorerRoot(folder: string) {
        if (!testExplorer) {
            return;
        }

        const normalizedFolder = util.platformNormalizePath(folder);
        testExplorer.items.add(testExplorer.createTestItem(normalizedFolder, normalizedFolder));
    }

    removeTestExplorerRoot(folder: string) {
        if (!testExplorer) {
            return;
        }

        const normalizedFolder = util.platformNormalizePath(folder);
        testExplorer.items.delete(normalizedFolder);
    }

    /**
     * If returning false, the test explorer is not available, and refreshTests can be called to construct it.
     * Since there's no way to reveal the explorer itself, this function reveals the first test in the test explorer.
     */
    async revealTestExplorer(): Promise<boolean> {
        if (!testExplorer) {
            return false;
        }

        const tests = this.testItemCollectionToArray(testExplorer.items);
        if (tests.length === 0) {
            return false;
        }

        await vscode.commands.executeCommand('vscode.revealTestInExplorer', tests[0]);
        return true;
    }
}

// Only have one instance of the test controller
let testExplorer: vscode.TestController | undefined;
