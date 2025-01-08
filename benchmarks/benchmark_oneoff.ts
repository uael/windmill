/// <reference no-default-lib="true" />
/// <reference lib="deno.window" />

import {Command} from "https://deno.land/x/cliffy@v0.25.7/command/mod.ts";
import {UpgradeCommand} from "https://deno.land/x/cliffy@v0.25.7/command/upgrade/upgrade_command.ts";
import {DenoLandProvider} from "https://deno.land/x/cliffy@v0.25.7/command/upgrade/mod.ts";

import {sleep} from "https://deno.land/x/sleep@v1.2.1/mod.ts";

import * as windmill from "https://deno.land/x/windmill@v1.174.0/mod.ts";
import * as api from "https://deno.land/x/windmill@v1.174.0/windmill-api/index.ts";

import {VERSION, createBenchScript, getFlowPayload, login} from "./lib.ts";

async function verifyOutputs(uuids: string[], workspace: string) {
  console.log("Verifying outputs");
  let incorrectResults = 0;
  for (const uuid of uuids) {
    try {
      const job = await windmill.JobService.getCompletedJob({
        workspace,
        id: uuid,
      });
      if (!job.success) {
        console.log(`Job ${uuid} did not complete`);
        incorrectResults++;
      }
      if (job.result !== uuid) {
        console.log(`Job ${uuid} did not output the correct value`);
        incorrectResults++;
      }
    } catch (_) {
      console.log(`Job ${uuid} did not complete`);
      incorrectResults++;
    }
  }
  console.log(`Incorrect results: ${incorrectResults}`);
}

export async function main({
                             host,
                             email,
                             password,
                             token,
                             workspace,
                             kind,
                             jobs,
                             noVerify,
                           }: {
  host: string;
  email?: string;
  password?: string;
  token?: string;
  workspace: string;
  kind: string;
  jobs: number;
  noVerify?: boolean;
}) {
  windmill.setClient("", host);

  console.log(
    "Started benchmark with options",
    JSON.stringify(
      {
        host,
        email,
        workspace,
        kind,
        jobs,
        noVerify,
      },
      null,
      4
    )
  );

  const config = {
    token: "",
    server: host,
    workspace_id: workspace,
  };

  let final_token: string;
  if (!token) {
    if (email && password) {
      final_token = await login(email, password);
    } else {
      console.error("Token or email with password are required.");
      return;
    }
  } else {
    final_token = token;
  }

  config.token = final_token;
  windmill.setClient(final_token, host);
  const enc = (s: string) => new TextEncoder().encode(s);

  async function getQueueCount() {
    return (
      await (
        await fetch(
          config.server + "/api/w/" + config.workspace_id + "/jobs/queue/count",
          {headers: {["Authorization"]: "Bearer " + config.token}}
        )
      ).json()
    ).database_length;
  }

  async function getFlowStepCount(
    workspace: string,
    path: string
  ): Promise<number> {
    const response = await fetch(
      `${config.server}/api/w/${workspace}/flows/get/${path}`,
      {headers: {["Authorization"]: "Bearer " + config.token}}
    );

    const data = await response.json();
    let stepCount = 0;

    for (const mod of data.value.modules) {
      if (mod.value.type === "flow" && mod.value.path) {
        const subFlowCount = await getFlowStepCount(workspace, mod.value.path);
        stepCount += subFlowCount;
      } else {
        stepCount += 1;
      }
    }

    return stepCount;
  }

  if (
    ["deno", "python", "go", "bash", "dedicated", "bun", "nativets"].includes(
      kind
    )
  ) {
    await createBenchScript(kind, workspace);
  }

  const jobsSent = jobs;
  console.log(`Bulk creating ${jobsSent} jobs`);

  const start_create = Date.now();
  let nStepsFlow = 0;
  let body: string;
  if (kind === "noop") {
    body = JSON.stringify({
      kind: "noop",
    });
  } else if (
    ["deno", "python", "go", "bash", "dedicated", "bun", "nativets"].includes(
      kind
    )
  ) {
    body = JSON.stringify({
      kind: "script",
      path: "f/benchmarks/" + kind,
    });
  } else if (["2steps", "bigscriptinflow"].includes(kind)) {
    nStepsFlow = kind == "2steps" ? 2 : 1;
    const payload = getFlowPayload(kind);
    body = JSON.stringify({
      kind: "flow",
      flow_value: payload.value,
    });
  } else if (kind.startsWith("flow:")) {
    console.log("Detected custom flow ");
    let flow_path = kind.substr(5);
    nStepsFlow = await getFlowStepCount(config.workspace_id, flow_path);
    console.log(`Total steps of flow including sub-flows: ${nStepsFlow}`);
    body = JSON.stringify({
      kind: "flow",
      path: flow_path,
    });
  } else if (kind.startsWith("script:")) {
    console.log("Detected custom script");
    body = JSON.stringify({
      kind: "script",
      path: kind.substr(7),
    });
  } else if (kind == "bigrawscript") {
    noVerify = true;
    body = JSON.stringify({
      kind: "rawscript",
      rawscript: {
        language: api.RawScript.language.BASH,
        content: "# let's bloat that bash script, 3.. 2.. 1.. BOOM\n".repeat(25000) + "echo \"$WM_FLOW_JOB_ID\"\n",
      },
    });
  } else {
    throw new Error("Unknown script pattern " + kind);
  }

  console.log("Creating jobs with body");
  const response = await fetch(
    config.server +
    "/api/w/" +
    config.workspace_id +
    `/jobs/add_batch_jobs/${jobsSent}`,
    {
      method: "POST",
      headers: {
        ["Authorization"]: "Bearer " + config.token,
        "Content-Type": "application/json",
      },
      body,
    }
  );
  console.log("Created jobs with body");
  if (!response.ok) {
    throw new Error(
      "Failed to create jobs: " +
      response.statusText +
      " " +
      (await response.text())
    );
  }
  const uuids = await response.json();
  const end_create = Date.now();
  const create_duration = end_create - start_create;

  console.log(
    `Jobs successfully added to the queue in ${(create_duration / 1000).toFixed(
      2
    )}s. Windmill will start pulling them.\n`
  );

  const start = Date.now();

  // We create an array of the same length as uuids, initialized to false
  // to track which jobs have completed.
  const completionStatus = new Array(uuids.length).fill(false);

  // Variables for throughput logging
  let lastElapsed = 0;
  let lastCompletedJobs = 0;

  async function isCompleted(id: string): Promise<boolean> {
    return (await fetch(
      config.server +
      "/api/w/" +
      config.workspace_id +
      `/jobs_u/getupdate/${id}?running=true&log_offset=0`,
      {
        headers: {
          ["Authorization"]: "Bearer " + config.token,
          "Content-Type": "application/json",
        },
      }
    )).json();
  }

  // Build an array of Promises (one per UUID)
  Promise.all(uuids.map(async (uuid, i) => {
    // Only check if we haven't already marked it as true
    while (!completionStatus[i]) {
      const result = await isCompleted(uuid);
      completionStatus[i] = result.completed === true;
    }
  }));

  while (true) {
    // Optional: throughput logging
    const elapsed = Date.now() - start;
    const completedJobs = completionStatus.filter(Boolean).length;

    const avgThr = ((completedJobs / elapsed) * 1000).toFixed(2);
    const instThr =
      lastElapsed > 0
        ? (
          ((completedJobs - lastCompletedJobs) / (elapsed - lastElapsed)) *
          1000
        ).toFixed(2)
        : 0;

    // Print status on the same line (like a progress bar)
    await Deno.stdout.write(
      enc(
        `elapsed: ${(elapsed / 1000).toFixed(2)}s | ` +
        `jobs executed: ${completedJobs}/${uuids.length} ` +
        `(thr: inst ${instThr} - avg ${avgThr}) | ` +
        `remaining: ${uuids.length - completedJobs}                  \r`
      )
    );

    // Prepare for next iteration
    lastElapsed = elapsed;
    lastCompletedJobs = completedJobs;

    if (completionStatus.every(Boolean)) {
      break;
    }

    // Sleep a bit to avoid hammering the server (adjust as needed)
    await sleep(0.2);
  }

  const total_duration_sec = (Date.now() - start) / 1000;
  console.log(`\njobs: ${uuids.length}`);
  console.log(`duration: ${total_duration_sec.toFixed(2)}s`);
  console.log(
    `avg. throughput (jobs/time): ${(uuids.length / total_duration_sec).toFixed(2)}`
  );

  console.log(`\njobs: ${jobsSent}`);
  console.log(`duration: ${total_duration_sec}s`);
  console.log(`avg. throughput (jobs/time): ${jobsSent / total_duration_sec}`);

  console.log("completed jobs", lastCompletedJobs);
  console.log("queue length:", await getQueueCount());

  if (
    !noVerify &&
    kind !== "noop" &&
    kind !== "nativets" &&
    !kind.startsWith("flow:") &&
    !kind.startsWith("script:")
  ) {
    await verifyOutputs(uuids, config.workspace_id);
  }

  console.log("done");

  return {
    throughput: jobsSent / total_duration_sec,
  };
}

if (import.meta.main) {
  await new Command()
    .name("wmillbench")
    .description("Run Benchmark to measure throughput of windmill.")
    .version(VERSION)
    .option("--host <url:string>", "The windmill host to benchmark.", {
      default: "http://127.0.0.1:8000",
    })
    .option("-e --email <email:string>", "The email to use to login.", {
      default: "admin@windmill.dev",
    })
    .option(
      "-p --password <password:string>",
      "The password to use to login.",
      {
        default: "changeme",
      }
    )
    .env(
      "WM_TOKEN=<token:string>",
      "The token to use when talking to the API server. Preferred over manual login."
    )
    .option(
      "-t --token <token:string>",
      "The token to use when talking to the API server. Preferred over manual login."
    )
    .env(
      "WM_WORKSPACE=<workspace:string>",
      "The workspace to spawn scripts from."
    )
    .option(
      "-w --workspace <workspace:string>",
      "The workspace to spawn scripts from.",
      {default: "admins"}
    )
    .option(
      "--kind <kind:string>",
      "Specifiy the benchmark kind among: deno, identity, python, go, bash, dedicated, bun, noop, 2steps, nativets",
      {
        required: true,
      }
    )
    .option("-j --jobs <jobs:number>", "Number of jobs to create.", {
      default: 10000,
    })
    .option("--no-verify", "Do not verify the output of the jobs.", {
      default: false,
    })
    .action(main)
    .command(
      "upgrade",
      new UpgradeCommand({
        main: "main.ts",
        args: [
          "--allow-net",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          "--unstable",
        ],
        provider: new DenoLandProvider({name: "wmillbench"}),
      })
    )
    .parse();
}
