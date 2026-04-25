#!/usr/bin/env bash
set -euo pipefail

schema_path="schema/sidecar-lifecycle.schema.json"
go_path="sidecar/internal/contracts/lifecycle.go"
drift_message="Schema ${schema_path}와 ${go_path} 사이 drift 발견. 수동 동기화 필요."

python3 - "$schema_path" "$go_path" "$drift_message" <<'PY'
import json
import re
import sys

schema_path, go_path, drift_message = sys.argv[1:]

with open(schema_path, "r", encoding="utf-8") as schema_file:
    schema = json.load(schema_file)

with open(go_path, "r", encoding="utf-8") as go_file:
    go_source = go_file.read()

defs = schema["$defs"]

enum_checks = {
    "sidecarStartReason": "SidecarStartReason",
    "sidecarStopReason": "SidecarStopReason",
    "sidecarStoppedReason": "SidecarStoppedReason",
}

variant_checks = {
    "sidecarStartCommand": "SidecarStartCommand",
    "sidecarStartedEvent": "SidecarStartedEvent",
    "sidecarStopCommand": "SidecarStopCommand",
    "sidecarStoppedEvent": "SidecarStoppedEvent",
}


def fail(details):
    print(drift_message, file=sys.stderr)
    for detail in details:
        print(f"- {detail}", file=sys.stderr)
    sys.exit(1)


def go_enum_values(type_name):
    pattern = re.compile(
        rf"const\s*\((?P<body>.*?)\)",
        re.DOTALL,
    )
    values = []
    for match in pattern.finditer(go_source):
        body = match.group("body")
        values.extend(
            re.findall(rf"\b\w+\s+{re.escape(type_name)}\s*=\s*\"([^\"]+)\"", body)
        )
    return values


def go_struct_json_fields(struct_name):
    match = re.search(
        rf"type\s+{re.escape(struct_name)}\s+struct\s*\{{(?P<body>.*?)\n\}}",
        go_source,
        re.DOTALL,
    )
    if match is None:
        return None
    fields = []
    for json_tag in re.findall(r"`json:\"([^\",]+)(?:,[^\"]*)?\"`", match.group("body")):
        if json_tag != "-":
            fields.append(json_tag)
    return fields


errors = []

for schema_def, go_type in enum_checks.items():
    schema_values = defs[schema_def].get("enum", [])
    actual_values = go_enum_values(go_type)
    if sorted(schema_values) != sorted(actual_values):
        errors.append(
            f"enum {go_type} 불일치: schema={schema_values}, go={actual_values}"
        )

for schema_def, go_struct in variant_checks.items():
    definition = defs[schema_def]
    if definition.get("additionalProperties") is not False:
        errors.append(f"{schema_def}.additionalProperties가 false가 아님")

    schema_properties = sorted(definition.get("properties", {}).keys())
    schema_required = sorted(definition.get("required", []))
    go_fields = go_struct_json_fields(go_struct)

    if go_fields is None:
        errors.append(f"Go struct {go_struct}를 찾을 수 없음")
        continue

    sorted_go_fields = sorted(go_fields)
    if schema_required != sorted(set(schema_required).intersection(go_fields)):
        missing_required = sorted(set(schema_required) - set(go_fields))
        errors.append(f"{go_struct} required 필드 누락: {missing_required}")

    if schema_properties != sorted_go_fields:
        missing = sorted(set(schema_properties) - set(go_fields))
        extra = sorted(set(go_fields) - set(schema_properties))
        errors.append(
            f"{go_struct} json tag 필드 불일치: missing={missing}, extra={extra}"
        )

if errors:
    fail(errors)

print(f"{schema_path}와 {go_path} drift 없음")
PY
