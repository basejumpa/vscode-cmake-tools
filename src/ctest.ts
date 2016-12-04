import * as xml2js from 'xml2js';

import * as async from './async';

interface SiteAttributes {

};

type TestStatus = ('failed');

export interface FailingTestDecoration {
    fileName: string;
    lineNumber: number;
    hoverMessage: string;
}

export interface TestMeasurement {
    type: string;
    name: string;
    value: any;
}

export interface Test {
    Status: TestStatus;
    FullCommandLine: string;
    FullName: string;
    Name: string;
    Path: string;
    Measurements: Map<string, TestMeasurement>;
    Output: string;
}

export interface TestingData {
    // Fill out when we need all the attributes
    TestList: string[];
    Test: Test[];
}

export interface SiteData {
    $: SiteAttributes;
    Testing: TestingData;
}

export interface Results {
    Site: SiteData;
}

interface MessyResults {
    Site: {
        $: {}
        Testing: {
            TestList: {
                Test: string[]
            }[]
            EndDateTime: string[]
            EndTestTime: string[]
            ElapsedMinutes: string[]
            Test: {
                $: {
                    Status: TestStatus
                }
                FullCommandLine: string[]
                FullName: string[]
                Name: string[]
                Path: string[]
                Results: {
                    NamedMeasurement: {
                        $: {
                            type: string
                            name: string
                        },
                        Value: string[]
                    }[]
                    Measurement: {
                        Value: string[]
                    }[]
                }[]
            }[]
        }[]
    };
}

function cleanupResultsXML(messy: MessyResults): Results {
    return {
        Site: {
            $: messy.Site.$,
            Testing: {
                TestList: messy.Site.Testing[0].TestList.map(l => l.Test[0]),
                Test: messy.Site.Testing[0].Test.map(
                    (test): Test => ({
                        FullName: test.FullName[0],
                        FullCommandLine: test.FullCommandLine[0],
                        Name: test.Name[0],
                        Path: test.Path[0],
                        Status: test.$.Status,
                        Measurements: new Map<string, TestMeasurement>(),
                        Output: test.Results[0].Measurement[0].Value[0]
                    })
                )
            }
        }
    };
}

function parseXMLString(xml: string): Promise<any> {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xml,
        (err, result) => {
            if (err) {
                reject(err);
            } else {
                resolve(result);
            }
        });
    });
}

export async function readTestResultsFile(test_xml: string): Promise<Results> {
    const content = (await async.readFile(test_xml)).toString();
    const data = await parseXMLString(content) as MessyResults;
    const clean = cleanupResultsXML(data);
    return clean;
}

export function parseCatchTestOutput(output: string): FailingTestDecoration[] {
    const lines_with_ws = output.split('\n');
    const lines = lines_with_ws.map(l => l.trim());
    const decorations: FailingTestDecoration[] = [];
    for (let cursor = 0; cursor < lines.length; ++cursor) {
        const line = lines[cursor];
        const regex = process.platform === 'win32'
            ? new RegExp(/^(.*)\((\d+)\): FAILED:/)
            : new RegExp(/^(.*):(\d+): FAILED:/);
        const res = regex.exec(line);
        if (res) {
            const [_, file, lineno_] = res;
            const lineno = parseInt(lineno_) - 1;
            let message = '~~~c++\n';
            for (let i = 0;; ++i) {
                const expr_line = lines_with_ws[cursor + i];
                if (expr_line.startsWith('======') || expr_line.startsWith('------')) {
                    break;
                }
                message += expr_line + '\n';
            }

            decorations.push({
                fileName: file,
                lineNumber: lineno,
                hoverMessage: `${message}\n~~~`,
            });
        }
    }
    return decorations;
}

export async function parseTestOutput(output: string): Promise<FailingTestDecoration[]> {
    if (/is a Catch .* host application\./.test(output)) {
        return parseCatchTestOutput(output);
    } else {
        return [];
    }
}
