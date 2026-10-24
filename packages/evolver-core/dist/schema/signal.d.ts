import { z } from 'zod';
/** 三层签名·工程层 (军杰 §4.2). camelCase (内部类型, schema §0 / 硬化 A10). */
export declare const eventSignature: z.ZodString;
/** 三层签名·领域层 (军杰 §4.3), 不含 gene_id. */
export declare const problemSignature: z.ZodString;
/** 选择压. 三条腿: 结构化强 / corpus 弱 / agent 自标 (批注#13). */
export declare const signal: z.ZodObject<{
    signalId: z.ZodString;
    fromMaterial: z.ZodDefault<z.ZodArray<z.ZodString>>;
    kind: z.ZodEnum<{
        strong_structured: "strong_structured";
        weak_corpus: "weak_corpus";
        agent_marked: "agent_marked";
        verified_success: "verified_success";
    }>;
    text: z.ZodString;
    score: z.ZodDefault<z.ZodNumber>;
    eventSignature: z.ZodString;
    problemSignature: z.ZodString;
    signatureV: z.ZodDefault<z.ZodNumber>;
    discoveredAt: z.ZodString;
    extensions: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
export type Signal = z.infer<typeof signal>;