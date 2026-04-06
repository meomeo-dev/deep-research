import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const cliPath = path.join(repoRoot, "dist/cli/main.js");
const demoRoot = path.join(__dirname, "project");
const outputPngPath = path.join(repoRoot, "docs/assets/readme/deep-research-demo-dag-50.png");
const outputHtmlPath = path.join(__dirname, "deep-research-demo-dag-50.html");
const summaryPath = path.join(__dirname, "deep-research-demo-dag-50.summary.json");

const phaseOneNodes = [
  ["RQ", "question", "Should multi-step prompting improve code generation reliability?", "Quantify where multi-step prompting materially improves code generation accuracy and where the extra reasoning cost is wasted.", "active", "untested"],
  ["LIT_COT", "note", "Prior literature favors structured reasoning on harder tasks", "Survey notes indicate chain-of-thought style prompting tends to help when tasks require decomposition rather than direct retrieval.", "resolved", "supported"],
  ["LIT_BENCH", "note", "Benchmark landscape clusters around HumanEval and MBPP", "Most comparable code-generation studies report results on HumanEval or MBPP, making them suitable for a README-friendly replication graph.", "resolved", "supported"],
  ["LIT_METRIC", "note", "Pass@k remains useful but hides cost and failure origin", "Existing reports over-index on Pass@1 and Pass@5 while under-reporting token overhead and reasoning-vs-code failure sources.", "resolved", "supported"],
  ["HYP_COMPLEXITY", "hypothesis", "Complex tasks should gain more than easy tasks", "The benefit of multi-step prompting should concentrate on medium and hard coding problems that require decomposition and edge-case planning.", "ready", "untested"],
  ["HYP_OVERHEAD", "hypothesis", "Prompt overhead may erase gains on easy tasks", "If reasoning tokens dominate simple tasks, overall ROI may turn negative even if quality rises slightly.", "ready", "untested"],
  ["HYP_TRANSFER", "hypothesis", "Cross-benchmark gains should persist but shrink", "A real effect should survive on a second benchmark, though the uplift may compress because task wording and test coverage differ.", "ready", "untested"],
  ["TASK_SCOPE", "task", "Fix the study scope to Python function generation", "Limit the first pass to Python code generation on interview-style function tasks so the example stays readable and reproducible.", "active", "untested"],
  ["TASK_CONTROL", "task", "Fix model, sampling, and cost envelope", "Hold the model family, temperature, and repetition count constant so observed differences come from prompting style rather than drifting conditions.", "active", "untested"],
  ["GAP_STEPS", "gap", "Optimal reasoning step count is still unknown", "Published work rarely shows where the gain curve saturates between direct prompting and deeper multi-step templates.", "ready", "inconclusive"],
  ["GAP_FAILURE", "gap", "Failure origin is often not separated", "The field still under-classifies whether a miss came from flawed reasoning, flawed code emission, or weak tests.", "ready", "inconclusive"],
  ["GAP_GENERALIZE", "gap", "Cross-benchmark stability remains under-tested", "A README demo should still show that the same pattern was checked on a second dataset instead of claiming one-benchmark certainty.", "ready", "inconclusive"],
  ["PLAN", "task", "Plan a four-stage research workflow", "Run the study as scope and hypothesis setup, protocol design, experiment execution, and synthesis so the DAG reads like a real deep research process.", "active", "untested"]
];

const phaseTwoNodes = [
  ["EVID_HE", "evidence", "HumanEval is the primary benchmark", "HumanEval provides a compact Python benchmark with test harnesses and is widely recognized for function-level code generation evaluation.", "resolved", "supported"],
  ["EVID_MBPP", "evidence", "MBPP works as an external validation set", "MBPP adds a larger Python task pool and gives the demo graph a second evidence-backed benchmark branch.", "resolved", "supported"],
  ["TASK_BUCKET", "task", "Bucket tasks into easy medium and hard", "Difficulty buckets will be assigned using solution length, algorithmic subtlety, and edge-case burden rather than a single scalar score.", "active", "untested"],
  ["TASK_DIRECT", "task", "Define the direct-prompt baseline", "The baseline prompt asks for code from signature and docstring without explicit reasoning steps.", "active", "untested"],
  ["TASK_COT2", "task", "Define a two-step reasoning template", "The two-step template asks the model to understand the task and choose an algorithm before writing code.", "active", "untested"],
  ["TASK_COT4", "task", "Define a four-step reasoning template", "The four-step template adds boundary checks, sanity review, and implementation planning before code generation.", "active", "untested"],
  ["TASK_SAMPLE", "task", "Fix temperature and repetition policy", "Each benchmark item will be sampled five times at the same temperature to compare pass rates under matched stochasticity.", "active", "untested"],
  ["TASK_PASS1", "task", "Measure Pass@1", "Track the single-sample success rate because it matches the most common real-world one-shot assistant workflow.", "active", "untested"],
  ["TASK_PASS5", "task", "Measure Pass@5", "Track whether repeated sampling rescues misses and changes the relative value of deeper prompting.", "active", "untested"],
  ["TASK_COST", "task", "Measure reasoning token cost", "Record prompt and response token footprints so the graph can show quality and cost instead of quality alone.", "active", "untested"],
  ["NOTE_CONTROL", "note", "Control conditions stay fixed across all runs", "Model version, test harness, and task text stay fixed for all prompting variants to preserve comparability.", "resolved", "supported"],
  ["TASK_SCHEDULE", "task", "Stage the runs and checkpoints", "Execute the baseline first, then the two-step template, then the four-step template, and reserve one additional pass for MBPP validation.", "active", "untested"]
];

const phaseThreeNodes = [
  ["EVID_DIRECT_RUN", "evidence", "Direct prompting run completed", "The baseline run completed across the primary benchmark and established the reference accuracy distribution.", "resolved", "supported"],
  ["EVID_COT2_RUN", "evidence", "Two-step prompting run completed", "The two-step run completed on the same task pool and produced enough samples for paired comparison.", "resolved", "supported"],
  ["EVID_COT4_RUN", "evidence", "Four-step prompting run completed", "The four-step run completed under identical controls and materially increased total reasoning tokens.", "resolved", "supported"],
  ["FIND_OVERALL", "finding", "Overall Pass@1 rises as prompting becomes more structured", "The primary benchmark shows a monotonic increase from direct prompting to two-step and then four-step prompting.", "resolved", "supported"],
  ["FIND_DIFFICULTY", "finding", "Uplift concentrates in medium and hard tasks", "Difficulty buckets reveal that easy tasks move little while medium and hard tasks account for most of the accuracy gain.", "resolved", "supported"],
  ["FIND_H1", "finding", "Complexity interaction hypothesis gets partial support", "The study supports the claim that harder problems benefit more, but the boundary is softer than the initial hypothesis suggested.", "resolved", "supported"],
  ["EVID_MBPP_RUN", "evidence", "MBPP validation run completed", "The second benchmark run finished with the same prompting variants and preserved the relative ordering of the methods.", "resolved", "supported"],
  ["FIND_MBPP", "finding", "Validation benchmark preserves the main trend", "The second dataset shows the same direction of effect, although the uplift magnitude is smaller than on HumanEval.", "resolved", "supported"],
  ["FIND_GENERALIZE", "finding", "Cross-benchmark pattern appears stable", "The validation pass reduces the risk that the README demo is just showcasing a single benchmark artifact.", "resolved", "supported"],
  ["NOTE_REASON_FAIL", "note", "A subset of misses stem from weak reasoning plans", "Manual review finds cases where the model misunderstood the task structure before it even reached code generation.", "resolved", "supported"],
  ["NOTE_CODE_FAIL", "note", "Another subset stems from code emission failures", "Other failures have a plausible plan but still break because of syntax, indexing mistakes, or incomplete edge-case handling.", "resolved", "supported"],
  ["FIND_FAILURE_MIX", "finding", "Failure causes are mixed rather than singular", "The error review indicates that prompt design helps reasoning but does not eliminate code emission mistakes.", "resolved", "supported"],
  ["FIND_COST", "finding", "Token cost climbs sharply with deeper prompting", "Four-step prompting substantially increases reasoning tokens, turning the quality gain into a cost-sensitive decision instead of a universal default.", "resolved", "supported"]
];

const phaseFourNodes = [
  ["EVID_STATS", "evidence", "Paired tests confirm the accuracy lift is significant", "A paired significance check indicates that the observed Pass@1 uplift is unlikely to be random noise on the primary benchmark.", "resolved", "supported"],
  ["EVID_POWER", "evidence", "Sample size is large enough for a modest effect", "The completed run volume is sufficient to detect a low-single-digit quality delta with high power.", "resolved", "supported"],
  ["FIND_ROI", "finding", "Return on prompting depth depends on task criticality", "The gain is meaningful for high-risk or expensive coding tasks but less attractive for routine requests where latency and cost dominate.", "resolved", "supported"],
  ["GAP_MODEL", "gap", "The result has only been checked on one model family", "The graph still leaves open whether the same prompt-depth curve holds on other frontier or open-weight coding models.", "ready", "inconclusive"],
  ["GAP_DOMAIN", "gap", "The task domain is still narrow", "The current demo focuses on Python function synthesis and does not claim coverage for debugging, system design, or repo-scale refactoring.", "ready", "inconclusive"],
  ["GAP_PROMPT", "gap", "The prompt design space is far from exhausted", "Direct, two-step, and four-step prompting are only one slice of the broader design space that includes self-consistency and tree search.", "ready", "inconclusive"],
  ["GAP_SATURATION", "gap", "The exact saturation point still needs mapping", "The study still cannot say whether three steps or five steps would be better than the tested templates.", "ready", "inconclusive"],
  ["GAP_TAXONOMY", "gap", "Reasoning failure taxonomy needs refinement", "The current error review is good enough for a demo but still too coarse for a production decision framework.", "ready", "inconclusive"],
  ["GAP_INTERACTION", "gap", "Model-method interaction remains unresolved", "Future model releases may compress or amplify the benefit of structured prompting, so the current conclusion must stay conditional.", "ready", "inconclusive"],
  ["CONC_MAIN", "conclusion", "Multi-step prompting improves reliability on harder coding tasks", "The strongest supported claim is that structured multi-step prompting raises code-generation reliability on more complex tasks.", "resolved", "supported"],
  ["CONC_SELECTIVE", "conclusion", "Use deeper prompting selectively rather than by default", "The cost profile argues for enabling deeper prompting on higher-stakes tasks while keeping direct prompting for simple requests.", "resolved", "supported"],
  ["TASK_NEXT", "task", "Run the next study on more models and prompt families", "The next research cycle should extend the benchmark to more model families and richer prompt strategies.", "ready", "untested"]
];

const phaseOneEdges = [
  ["LIT_COT", "HYP_COMPLEXITY", "supports"],
  ["LIT_COT", "HYP_OVERHEAD", "supports"],
  ["LIT_BENCH", "HYP_TRANSFER", "supports"],
  ["LIT_METRIC", "GAP_FAILURE", "supports"],
  ["RQ", "HYP_COMPLEXITY", "derived_from"],
  ["RQ", "HYP_OVERHEAD", "derived_from"],
  ["RQ", "HYP_TRANSFER", "derived_from"],
  ["RQ", "TASK_SCOPE", "depends_on"],
  ["RQ", "TASK_CONTROL", "depends_on"],
  ["HYP_COMPLEXITY", "GAP_STEPS", "supports"],
  ["HYP_TRANSFER", "GAP_GENERALIZE", "supports"],
  ["GAP_STEPS", "PLAN", "depends_on"],
  ["GAP_FAILURE", "PLAN", "depends_on"],
  ["GAP_GENERALIZE", "PLAN", "depends_on"],
  ["TASK_SCOPE", "PLAN", "depends_on"],
  ["TASK_CONTROL", "PLAN", "depends_on"]
];

const phaseTwoEdges = [
  ["PLAN", "EVID_HE", "depends_on"],
  ["PLAN", "EVID_MBPP", "depends_on"],
  ["EVID_HE", "TASK_BUCKET", "supports"],
  ["EVID_MBPP", "TASK_BUCKET", "supports"],
  ["PLAN", "TASK_DIRECT", "depends_on"],
  ["PLAN", "TASK_COT2", "depends_on"],
  ["PLAN", "TASK_COT4", "depends_on"],
  ["TASK_SCOPE", "TASK_DIRECT", "supports"],
  ["TASK_SCOPE", "TASK_COT2", "supports"],
  ["TASK_SCOPE", "TASK_COT4", "supports"],
  ["TASK_CONTROL", "TASK_SAMPLE", "supports"],
  ["TASK_DIRECT", "TASK_SAMPLE", "depends_on"],
  ["TASK_COT2", "TASK_SAMPLE", "depends_on"],
  ["TASK_COT4", "TASK_SAMPLE", "depends_on"],
  ["TASK_SAMPLE", "TASK_PASS1", "depends_on"],
  ["TASK_SAMPLE", "TASK_PASS5", "depends_on"],
  ["TASK_SAMPLE", "TASK_COST", "depends_on"],
  ["TASK_CONTROL", "NOTE_CONTROL", "annotates"],
  ["NOTE_CONTROL", "TASK_SCHEDULE", "supports"],
  ["TASK_BUCKET", "TASK_SCHEDULE", "supports"],
  ["TASK_PASS1", "TASK_SCHEDULE", "supports"],
  ["TASK_PASS5", "TASK_SCHEDULE", "supports"],
  ["TASK_COST", "TASK_SCHEDULE", "supports"]
];

const phaseThreeEdges = [
  ["TASK_SCHEDULE", "EVID_DIRECT_RUN", "depends_on"],
  ["TASK_SCHEDULE", "EVID_COT2_RUN", "depends_on"],
  ["TASK_SCHEDULE", "EVID_COT4_RUN", "depends_on"],
  ["EVID_DIRECT_RUN", "FIND_OVERALL", "supports"],
  ["EVID_COT2_RUN", "FIND_OVERALL", "supports"],
  ["EVID_COT4_RUN", "FIND_OVERALL", "supports"],
  ["TASK_BUCKET", "FIND_DIFFICULTY", "supports"],
  ["EVID_DIRECT_RUN", "FIND_DIFFICULTY", "supports"],
  ["EVID_COT2_RUN", "FIND_DIFFICULTY", "supports"],
  ["EVID_COT4_RUN", "FIND_DIFFICULTY", "supports"],
  ["FIND_DIFFICULTY", "FIND_H1", "supports"],
  ["HYP_COMPLEXITY", "FIND_H1", "derived_from"],
  ["TASK_SCHEDULE", "EVID_MBPP_RUN", "depends_on"],
  ["EVID_MBPP_RUN", "FIND_MBPP", "supports"],
  ["HYP_TRANSFER", "FIND_MBPP", "derived_from"],
  ["FIND_MBPP", "FIND_GENERALIZE", "supports"],
  ["GAP_GENERALIZE", "FIND_GENERALIZE", "derived_from"],
  ["EVID_COT4_RUN", "NOTE_REASON_FAIL", "annotates"],
  ["EVID_COT4_RUN", "NOTE_CODE_FAIL", "annotates"],
  ["NOTE_REASON_FAIL", "FIND_FAILURE_MIX", "supports"],
  ["NOTE_CODE_FAIL", "FIND_FAILURE_MIX", "supports"],
  ["GAP_FAILURE", "FIND_FAILURE_MIX", "derived_from"],
  ["TASK_COST", "FIND_COST", "derived_from"],
  ["EVID_COT4_RUN", "FIND_COST", "supports"]
];

const phaseFourEdges = [
  ["FIND_OVERALL", "EVID_STATS", "supports"],
  ["EVID_DIRECT_RUN", "EVID_STATS", "supports"],
  ["EVID_COT4_RUN", "EVID_STATS", "supports"],
  ["EVID_DIRECT_RUN", "EVID_POWER", "supports"],
  ["EVID_COT2_RUN", "EVID_POWER", "supports"],
  ["EVID_COT4_RUN", "EVID_POWER", "supports"],
  ["EVID_STATS", "FIND_ROI", "supports"],
  ["FIND_COST", "FIND_ROI", "supports"],
  ["FIND_DIFFICULTY", "FIND_ROI", "supports"],
  ["GAP_GENERALIZE", "GAP_MODEL", "derived_from"],
  ["TASK_SCOPE", "GAP_DOMAIN", "derived_from"],
  ["TASK_COT4", "GAP_PROMPT", "derived_from"],
  ["GAP_STEPS", "GAP_SATURATION", "derived_from"],
  ["FIND_FAILURE_MIX", "GAP_TAXONOMY", "derived_from"],
  ["HYP_TRANSFER", "GAP_INTERACTION", "derived_from"],
  ["FIND_DIFFICULTY", "CONC_MAIN", "supports"],
  ["FIND_H1", "CONC_MAIN", "supports"],
  ["FIND_GENERALIZE", "CONC_MAIN", "supports"],
  ["FIND_ROI", "CONC_SELECTIVE", "supports"],
  ["CONC_MAIN", "CONC_SELECTIVE", "supports"],
  ["GAP_MODEL", "TASK_NEXT", "depends_on"],
  ["GAP_PROMPT", "TASK_NEXT", "depends_on"],
  ["GAP_SATURATION", "TASK_NEXT", "depends_on"],
  ["GAP_TAXONOMY", "TASK_NEXT", "depends_on"],
  ["GAP_INTERACTION", "TASK_NEXT", "depends_on"]
];

const phases = [
  { name: "phase-1-formulation", nodes: phaseOneNodes, edges: phaseOneEdges, snapshot: "Phase 1: formulate question, hypotheses, and gaps" },
  { name: "phase-2-design", nodes: phaseTwoNodes, edges: phaseTwoEdges, snapshot: "Phase 2: define benchmark protocol and controls" },
  { name: "phase-3-execution", nodes: phaseThreeNodes, edges: phaseThreeEdges, snapshot: "Phase 3: record run evidence and findings" },
  { name: "phase-4-synthesis", nodes: phaseFourNodes, edges: phaseFourEdges, snapshot: "Phase 4: synthesize significance, gaps, and conclusions" }
];

const runCli = (args) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${args.join(" ")}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n"));
  }

  return result.stdout.trim();
};

const listNodes = () => {
  const payload = JSON.parse(runCli(["node_list", "--project", demoRoot, "--format", "json"]));
  return payload.data;
};

const buildIdMap = () => {
  const idMap = new Map();
  for (const node of listNodes()) {
    idMap.set(node.title, node.id);
  }
  return idMap;
};

const addNodes = (nodes) => {
  for (const [, kind, title, body, workflowState, epistemicState] of nodes) {
    runCli([
      "node_add",
      "--project",
      demoRoot,
      "--kind",
      kind,
      "--title",
      title,
      "--body",
      body,
      "--workflow-state",
      workflowState,
      "--epistemic-state",
      epistemicState,
      "--format",
      "json"
    ]);
  }
};

const addEdges = (edges, titleByKey) => {
  const idMap = buildIdMap();
  for (const [fromKey, toKey, kind] of edges) {
    const fromId = idMap.get(titleByKey.get(fromKey));
    const toId = idMap.get(titleByKey.get(toKey));
    if (!fromId || !toId) {
      throw new Error(`Missing node for edge ${fromKey} -> ${toKey}`);
    }
    runCli([
      "graph_link",
      "--project",
      demoRoot,
      "--from",
      String(fromId),
      "--to",
      String(toId),
      "--kind",
      kind,
      "--format",
      "json"
    ]);
  }
};

const snapshot = (reason) => {
  runCli([
    "graph_snapshot",
    "--project",
    demoRoot,
    "--reason",
    reason,
    "--format",
    "json"
  ]);
};

const ensureEmptyProject = () => {
  fs.mkdirSync(demoRoot, { recursive: true });
  const dbPath = path.join(demoRoot, ".deep-research", "deep-research.db");
  if (fs.existsSync(dbPath)) {
    throw new Error(`Demo project already exists at ${demoRoot}. Remove it before rerunning this script.`);
  }
};

const main = () => {
  ensureEmptyProject();
  fs.mkdirSync(path.dirname(outputPngPath), { recursive: true });

  const titleByKey = new Map();
  for (const phase of phases) {
    for (const [key, , title] of phase.nodes) {
      titleByKey.set(key, title);
    }
  }

  runCli([
    "init",
    "--project",
    demoRoot,
    "--title",
    "Structured research demo: multi-step prompting for code generation",
    "--question",
    "When does multi-step prompting materially improve code generation reliability enough to justify its extra token cost?",
    "--format",
    "json"
  ]);

  runCli(["run", "--project", demoRoot, "--mode", "plan", "--format", "json"]);

  for (const phase of phases) {
    addNodes(phase.nodes);
    addEdges(phase.edges, titleByKey);
    snapshot(phase.snapshot);
  }

  const graphCheck = JSON.parse(runCli(["graph_check", "--project", demoRoot, "--format", "json"]));
  const exportPayload = JSON.parse(runCli([
    "graph_export",
    "--project",
    demoRoot,
    "--export-format",
    "png",
    "--output",
    outputPngPath,
    "--format",
    "json"
  ]));
  const visualizePayload = JSON.parse(runCli([
    "graph_visualize",
    "--project",
    demoRoot,
    "--html-path",
    outputHtmlPath,
    "--format",
    "json"
  ]));
  const graphPayload = JSON.parse(runCli(["graph_show", "--project", demoRoot, "--format", "json"]));

  const summary = {
    edgeCount: graphPayload.data.edges.length,
    graphCheck,
    htmlPath: visualizePayload.data.htmlPath,
    nodeCount: graphPayload.data.nodes.length,
    phaseSizes: phases.map((phase) => ({ name: phase.name, nodeCount: phase.nodes.length, edgeCount: phase.edges.length })),
    pngExport: exportPayload.data,
    projectRoot: demoRoot,
    researchQuestion: "When does multi-step prompting materially improve code generation reliability enough to justify its extra token cost?",
    title: "Structured research demo: multi-step prompting for code generation"
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
};

main();
