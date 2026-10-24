import { z } from 'zod';
export declare const recipeIpcBodyLimits: Readonly<{
    'POST /recipe/express': number;
    'POST /recipe/report': number;
    'POST /recipe/finalize': number;
}>;
export type RecipeJson = null | boolean | number | string | RecipeJson[] | {
    [key: string]: RecipeJson;
};
export declare const recipeEvidenceSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    artifacts: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>>;
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"artifact">;
}, z.core.$strict>, z.ZodObject<{
    artifacts: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        sha256: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>>;
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"tool_result">;
}, z.core.$strict>, z.ZodObject<{
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"text_transform">;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodEnum<{
        failed: "failed";
        unsupported: "unsupported";
        refused: "refused";
    }>;
    reason: z.ZodString;
    input_digest: z.ZodString;
    output_digest: z.ZodString;
    type: z.ZodLiteral<"failure">;
}, z.core.$strict>], "type">;
export declare const recipeExecutionSchemas: {
    express: z.ZodObject<{
        recipeId: z.ZodString;
        inputPayload: z.ZodOptional<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        requestKey: z.ZodString;
        maxCredits: z.ZodNumber;
        executionMode: z.ZodEnum<{
            provider: "provider";
            caller: "caller";
        }>;
        ttl: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>;
    get: z.ZodObject<{
        organismId: z.ZodString;
    }, z.core.$strict>;
    list: z.ZodObject<{
        role: z.ZodOptional<z.ZodEnum<{
            participant: "participant";
            requester: "requester";
            executor: "executor";
        }>>;
        limit: z.ZodOptional<z.ZodNumber>;
        cursor: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>;
    task: z.ZodObject<{
        taskId: z.ZodString;
    }, z.core.$strict>;
    claim: z.ZodObject<{
        leaseId: z.ZodString;
        organismId: z.ZodString;
    }, z.core.$strict>;
    next: z.ZodObject<{
        leaseId: z.ZodString;
        fence: z.ZodNumber;
        organismId: z.ZodString;
    }, z.core.$strict>;
    report: z.ZodObject<{
        position: z.ZodNumber;
        assetId: z.ZodString;
        output: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        evidence: z.ZodDiscriminatedUnion<[z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"artifact">;
        }, z.core.$strict>, z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"tool_result">;
        }, z.core.$strict>, z.ZodObject<{
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"text_transform">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodEnum<{
                failed: "failed";
                unsupported: "unsupported";
                refused: "refused";
            }>;
            reason: z.ZodString;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"failure">;
        }, z.core.$strict>], "type">;
        requestKey: z.ZodString;
        leaseId: z.ZodString;
        fence: z.ZodNumber;
        organismId: z.ZodString;
    }, z.core.$strict>;
    finalize: z.ZodObject<{
        output: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        evidence: z.ZodDiscriminatedUnion<[z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"artifact">;
        }, z.core.$strict>, z.ZodObject<{
            artifacts: z.ZodArray<z.ZodObject<{
                name: z.ZodString;
                sha256: z.ZodString;
                bytes: z.ZodNumber;
            }, z.core.$strict>>;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"tool_result">;
        }, z.core.$strict>, z.ZodObject<{
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"text_transform">;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodEnum<{
                failed: "failed";
                unsupported: "unsupported";
                refused: "refused";
            }>;
            reason: z.ZodString;
            input_digest: z.ZodString;
            output_digest: z.ZodString;
            type: z.ZodLiteral<"failure">;
        }, z.core.$strict>], "type">;
        leaseId: z.ZodString;
        fence: z.ZodNumber;
        organismId: z.ZodString;
    }, z.core.$strict>;
    cancel: z.ZodObject<{
        organismId: z.ZodString;
    }, z.core.$strict>;
};
export type RecipeExecutionOperation = keyof typeof recipeExecutionSchemas;
export type RecipeExecutionInputs = {
    [K in RecipeExecutionOperation]: z.infer<typeof recipeExecutionSchemas[K]>;
};
export declare const recipePrivateExpressionSchema: z.ZodObject<{
    id: z.ZodString;
    recipe_id: z.ZodString;
    status: z.ZodString;
    ttl: z.ZodNumber;
    born_at: z.ZodString;
    died_at: z.ZodNullable<z.ZodString>;
    total_duration: z.ZodNullable<z.ZodNumber>;
    genes_expressed: z.ZodNumber;
    genes_total_count: z.ZodNumber;
    created_at: z.ZodString;
    requester_node_id: z.ZodNullable<z.ZodString>;
    executor_node_id: z.ZodNullable<z.ZodString>;
    execution_mode: z.ZodString;
    billing_mode: z.ZodString;
    request_key: z.ZodNullable<z.ZodString>;
    cause_of_death: z.ZodNullable<z.ZodString>;
    input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
    output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
    expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
    capsule_ids: z.ZodArray<z.ZodString>;
    task_id: z.ZodNullable<z.ZodString>;
    bounty_id: z.ZodNullable<z.ZodString>;
    manifest: z.ZodNullable<z.ZodObject<{
        schema: z.ZodLiteral<"recipe_execution.v1">;
        recipeId: z.ZodString;
        version: z.ZodNumber;
        ownerNodeId: z.ZodString;
        title: z.ZodString;
        price: z.ZodNumber;
        inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        digest: z.ZodString;
        steps: z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            geneAssetId: z.ZodString;
            assetType: z.ZodString;
            condition: z.ZodNullable<z.ZodString>;
            parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            optional: z.ZodBoolean;
            fallbackGeneId: z.ZodNullable<z.ZodString>;
        }, z.core.$strip>>;
        assets: z.ZodRecord<z.ZodString, z.ZodObject<{
            assetId: z.ZodString;
            assetType: z.ZodString;
            payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
            triggerText: z.ZodString;
            digest: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
    execution_fence: z.ZodNumber;
    lease_expires_at: z.ZodNullable<z.ZodString>;
    assurance: z.ZodString;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        position: z.ZodNumber;
        asset_id: z.ZodString;
        status: z.ZodString;
        output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        input_digest: z.ZodNullable<z.ZodString>;
        attempt: z.ZodNumber;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export declare const recipeExecutionResponses: {
    express: z.ZodObject<{
        status: z.ZodLiteral<"accepted">;
        organism: z.ZodObject<{
            id: z.ZodString;
            recipe_id: z.ZodString;
            status: z.ZodString;
            ttl: z.ZodNumber;
            born_at: z.ZodString;
            died_at: z.ZodNullable<z.ZodString>;
            total_duration: z.ZodNullable<z.ZodNumber>;
            genes_expressed: z.ZodNumber;
            genes_total_count: z.ZodNumber;
            created_at: z.ZodString;
            requester_node_id: z.ZodNullable<z.ZodString>;
            executor_node_id: z.ZodNullable<z.ZodString>;
            execution_mode: z.ZodString;
            billing_mode: z.ZodString;
            request_key: z.ZodNullable<z.ZodString>;
            cause_of_death: z.ZodNullable<z.ZodString>;
            input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
            capsule_ids: z.ZodArray<z.ZodString>;
            task_id: z.ZodNullable<z.ZodString>;
            bounty_id: z.ZodNullable<z.ZodString>;
            manifest: z.ZodNullable<z.ZodObject<{
                schema: z.ZodLiteral<"recipe_execution.v1">;
                recipeId: z.ZodString;
                version: z.ZodNumber;
                ownerNodeId: z.ZodString;
                title: z.ZodString;
                price: z.ZodNumber;
                inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                digest: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    position: z.ZodNumber;
                    geneAssetId: z.ZodString;
                    assetType: z.ZodString;
                    condition: z.ZodNullable<z.ZodString>;
                    parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                    optional: z.ZodBoolean;
                    fallbackGeneId: z.ZodNullable<z.ZodString>;
                }, z.core.$strip>>;
                assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                    assetId: z.ZodString;
                    assetType: z.ZodString;
                    payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                    triggerText: z.ZodString;
                    digest: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
            completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            execution_fence: z.ZodNumber;
            lease_expires_at: z.ZodNullable<z.ZodString>;
            assurance: z.ZodString;
            steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                asset_id: z.ZodString;
                status: z.ZodString;
                output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                input_digest: z.ZodNullable<z.ZodString>;
                attempt: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>;
    }, z.core.$strip>;
    get: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        capsule_ids: z.ZodArray<z.ZodString>;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
    list: z.ZodObject<{
        organisms: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            recipe_id: z.ZodString;
            status: z.ZodString;
            ttl: z.ZodNumber;
            born_at: z.ZodString;
            died_at: z.ZodNullable<z.ZodString>;
            total_duration: z.ZodNullable<z.ZodNumber>;
            genes_expressed: z.ZodNumber;
            genes_total_count: z.ZodNumber;
            created_at: z.ZodString;
            requester_node_id: z.ZodNullable<z.ZodString>;
            executor_node_id: z.ZodNullable<z.ZodString>;
            execution_mode: z.ZodString;
            billing_mode: z.ZodString;
            request_key: z.ZodNullable<z.ZodString>;
            cause_of_death: z.ZodNullable<z.ZodString>;
            input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
            capsule_ids: z.ZodArray<z.ZodString>;
            task_id: z.ZodNullable<z.ZodString>;
            bounty_id: z.ZodNullable<z.ZodString>;
            manifest: z.ZodNullable<z.ZodObject<{
                schema: z.ZodLiteral<"recipe_execution.v1">;
                recipeId: z.ZodString;
                version: z.ZodNumber;
                ownerNodeId: z.ZodString;
                title: z.ZodString;
                price: z.ZodNumber;
                inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                digest: z.ZodString;
                steps: z.ZodArray<z.ZodObject<{
                    position: z.ZodNumber;
                    geneAssetId: z.ZodString;
                    assetType: z.ZodString;
                    condition: z.ZodNullable<z.ZodString>;
                    parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                    optional: z.ZodBoolean;
                    fallbackGeneId: z.ZodNullable<z.ZodString>;
                }, z.core.$strip>>;
                assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                    assetId: z.ZodString;
                    assetType: z.ZodString;
                    payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                    triggerText: z.ZodString;
                    digest: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>;
            completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            execution_fence: z.ZodNumber;
            lease_expires_at: z.ZodNullable<z.ZodString>;
            assurance: z.ZodString;
            steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                asset_id: z.ZodString;
                status: z.ZodString;
                output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                input_digest: z.ZodNullable<z.ZodString>;
                attempt: z.ZodNumber;
            }, z.core.$strip>>>;
        }, z.core.$strip>>;
        next_cursor: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
    task: z.ZodNullable<z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        capsule_ids: z.ZodArray<z.ZodString>;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    claim: z.ZodObject<{
        organism_id: z.ZodString;
        lease_id: z.ZodString;
        fence: z.ZodNumber;
        lease_expires_at: z.ZodString;
    }, z.core.$strip>;
    next: z.ZodDiscriminatedUnion<[z.ZodObject<{
        organism_id: z.ZodString;
        done: z.ZodLiteral<true>;
        finalization_input_digest: z.ZodString;
        output_schema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
    }, z.core.$strip>, z.ZodObject<{
        organism_id: z.ZodString;
        done: z.ZodLiteral<false>;
        position: z.ZodNumber;
        asset_id: z.ZodString;
        asset_type: z.ZodString;
        asset_payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        input: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        input_digest: z.ZodString;
        optional: z.ZodBoolean;
        fence: z.ZodNumber;
        assurance: z.ZodLiteral<"executor_reported">;
    }, z.core.$strip>], "done">;
    report: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        capsule_ids: z.ZodArray<z.ZodString>;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
    finalize: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        capsule_ids: z.ZodArray<z.ZodString>;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
    cancel: z.ZodObject<{
        id: z.ZodString;
        recipe_id: z.ZodString;
        status: z.ZodString;
        ttl: z.ZodNumber;
        born_at: z.ZodString;
        died_at: z.ZodNullable<z.ZodString>;
        total_duration: z.ZodNullable<z.ZodNumber>;
        genes_expressed: z.ZodNumber;
        genes_total_count: z.ZodNumber;
        created_at: z.ZodString;
        requester_node_id: z.ZodNullable<z.ZodString>;
        executor_node_id: z.ZodNullable<z.ZodString>;
        execution_mode: z.ZodString;
        billing_mode: z.ZodString;
        request_key: z.ZodNullable<z.ZodString>;
        cause_of_death: z.ZodNullable<z.ZodString>;
        input_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        output_payload: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        expression_log: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
        capsule_ids: z.ZodArray<z.ZodString>;
        task_id: z.ZodNullable<z.ZodString>;
        bounty_id: z.ZodNullable<z.ZodString>;
        manifest: z.ZodNullable<z.ZodObject<{
            schema: z.ZodLiteral<"recipe_execution.v1">;
            recipeId: z.ZodString;
            version: z.ZodNumber;
            ownerNodeId: z.ZodString;
            title: z.ZodString;
            price: z.ZodNumber;
            inputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            outputSchema: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            digest: z.ZodString;
            steps: z.ZodArray<z.ZodObject<{
                position: z.ZodNumber;
                geneAssetId: z.ZodString;
                assetType: z.ZodString;
                condition: z.ZodNullable<z.ZodString>;
                parameters: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
                optional: z.ZodBoolean;
                fallbackGeneId: z.ZodNullable<z.ZodString>;
            }, z.core.$strip>>;
            assets: z.ZodRecord<z.ZodString, z.ZodObject<{
                assetId: z.ZodString;
                assetType: z.ZodString;
                payload: z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>;
                triggerText: z.ZodString;
                digest: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        completion_evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
        execution_fence: z.ZodNumber;
        lease_expires_at: z.ZodNullable<z.ZodString>;
        assurance: z.ZodString;
        steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
            position: z.ZodNumber;
            asset_id: z.ZodString;
            status: z.ZodString;
            output: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            evidence: z.ZodNullable<z.ZodType<RecipeJson, unknown, z.core.$ZodTypeInternals<RecipeJson, unknown>>>;
            input_digest: z.ZodNullable<z.ZodString>;
            attempt: z.ZodNumber;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
};
export type RecipeExecutionOutputs = {
    [K in RecipeExecutionOperation]: z.infer<typeof recipeExecutionResponses[K]>;
};
export type RecipeExecutionSendState = 'not_sent' | 'unknown';
export interface PreparedRecipeExecution<K extends RecipeExecutionOperation> {
    invoke(): Promise<RecipeExecutionOutputs[K]>;
}
export declare class RecipeExecutionError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryAfterMs?: number | undefined;
    readonly commitState: 'rejected' | 'unknown';
    readonly sendState: RecipeExecutionSendState;
    constructor(code: string, status: number, retryAfterMs?: number | undefined, commitState?: 'rejected' | 'unknown', sendState?: RecipeExecutionSendState);
}
export interface RecipeExecutionCapability {
    readonly protocolVersion: 1;
    scope(): string;
    prepare?<K extends RecipeExecutionOperation>(operation: K, input: RecipeExecutionInputs[K], expectedScope?: string): Promise<PreparedRecipeExecution<K>>;
    invoke<K extends RecipeExecutionOperation>(operation: K, input: RecipeExecutionInputs[K], expectedScope?: string): Promise<RecipeExecutionOutputs[K]>;
}
export declare function parseRecipeExecutionInput<K extends RecipeExecutionOperation>(operation: K, input: unknown): RecipeExecutionInputs[K];
export declare function requireRecipeExecution(capability: RecipeExecutionCapability | undefined): RecipeExecutionCapability;