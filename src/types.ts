export interface HranaValue {
	type: "integer" | "float" | "text" | "blob" | "null";
	value?: string | number;
}

export interface HranaStatement {
	sql?: string;
	sql_id?: number;
	args?: HranaValue[];
	named_args?: { name: string; value: HranaValue }[];
	want_rows?: boolean;
}

export interface HranaBatchStep {
	stmt: HranaStatement;
	condition?: {
		type: "ok" | "not" | "and" | "or" | "is_autocommit";
		step?: number;
		cond?: HranaBatchStep["condition"];
		conds?: HranaBatchStep["condition"][];
	};
}

export type HranaRequestType =
	| "execute"
	| "close"
	| "batch"
	| "store_sql"
	| "close_sql"
	| "sequence"
	| "describe"
	| "get_autocommit";

export interface HranaRequest {
	type: HranaRequestType;
	stmt?: HranaStatement;
	batch?: { steps: HranaBatchStep[] };
	sql_id?: number;
	sql?: string;
}

export interface HranaPipelineRequest {
	baton?: string | null;
	requests: HranaRequest[];
}

export interface ServerConfig {
	port: number;
	dbDir: string;
}
