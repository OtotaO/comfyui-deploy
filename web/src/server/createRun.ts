"use server";

import { withServerPromise } from "./withServerPromise";
import { db } from "@/db/db";
import { machinesTable, workflowRunsTable } from "@/db/schema";
import { ComfyAPI_Run } from "@/types/ComfyAPI_Run";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import "server-only";
import { v4 } from "uuid";

export const createRun = withServerPromise(
  async (
    origin: string,
    workflow_version_id: string,
    machine_id: string,
    inputs?: Record<string, string>,
    isManualRun?: boolean
  ) => {
    const machine = await db.query.machinesTable.findFirst({
      where: and(
        eq(machinesTable.id, machine_id),
        eq(machinesTable.disabled, false)
      ),
    });

    if (!machine) {
      throw new Error("Machine not found");
    }

    const workflow_version_data = await db.query.workflowVersionTable.findFirst(
      {
        where: eq(workflowRunsTable.id, workflow_version_id),
      }
    );

    if (!workflow_version_data) {
      throw new Error("Workflow version not found");
    }

    const workflow_api = workflow_version_data.workflow_api;

    // Replace the inputs
    if (inputs && workflow_api) {
      for (const key in inputs) {
        Object.entries(workflow_api).forEach(([_, node]) => {
          if (node.inputs["input_id"] === key) {
            node.inputs["input_id"] = inputs[key];
          }
        });
      }
    }

    let prompt_id: string | undefined = undefined;
    const shareData = {
      workflow_api: workflow_api,
      status_endpoint: `${origin}/api/update-run`,
      file_upload_endpoint: `${origin}/api/file-upload`,
    };

    prompt_id = v4();

    // Add to our db
    const workflow_run = await db
      .insert(workflowRunsTable)
      .values({
        id: prompt_id,
        workflow_id: workflow_version_data.workflow_id,
        workflow_version_id: workflow_version_data.id,
        workflow_inputs: inputs,
        machine_id,
        origin: isManualRun ? "manual" : "api",
      })
      .returning();

    revalidatePath(`/${workflow_version_data.workflow_id}`);

    try {
      switch (machine.type) {
        case "runpod-serverless":
          const data = {
            input: {
              ...shareData,
              prompt_id: prompt_id,
            },
          };

          if (
            !machine.auth_token &&
            !machine.endpoint.includes("localhost") &&
            !machine.endpoint.includes("127.0.0.1")
          ) {
            throw new Error("Machine auth token not found");
          }

          const __result = await fetch(`${machine.endpoint}/run`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${machine.auth_token}`,
            },
            body: JSON.stringify(data),
            cache: "no-store",
          });
          console.log(__result);
          if (!__result.ok)
            throw new Error(`Error creating run, ${__result.statusText}`);
          console.log(data, __result);
          break;
        case "classic":
          const body = {
            ...shareData,
            prompt_id: prompt_id,
          };
          // console.log(body);
          const comfyui_endpoint = `${machine.endpoint}/comfyui-deploy/run`;
          const _result = await fetch(comfyui_endpoint, {
            method: "POST",
            body: JSON.stringify(body),
            cache: "no-store",
          });
          // console.log(_result);

          if (!_result.ok) {
            let message = `Error creating run, ${_result.statusText}`;
            try {
              const result = await ComfyAPI_Run.parseAsync(
                await _result.json()
              );
              message += ` ${result.node_errors}`;
            } catch (error) {}
            throw new Error(message);
          }
          // prompt_id = result.prompt_id;
          break;
      }
    } catch (e) {
      console.error(e);
      await db
        .update(workflowRunsTable)
        .set({
          status: "failed",
        })
        .where(eq(workflowRunsTable.id, workflow_run[0].id));
      throw e;
    }

    return {
      workflow_run_id: workflow_run[0].id,
      message: "Successful workflow run",
    };
  }
);
