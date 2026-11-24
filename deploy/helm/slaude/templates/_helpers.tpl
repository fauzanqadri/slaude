{{/* The selector name (app.kubernetes.io/name). */}}
{{- define "slaude.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The prefix of every object name. */}}
{{- define "slaude.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "slaude.name" . -}}
{{- end -}}
{{- end -}}

{{/* metadata.labels for an object of one component. Call with (dict "root" $ "component" "gateway"). */}}
{{- define "slaude.labels" -}}
app.kubernetes.io/name: {{ include "slaude.name" .root }}
app.kubernetes.io/component: {{ .component }}
{{- with .root.Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "slaude.selector" -}}
app.kubernetes.io/name: {{ include "slaude.name" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "slaude.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "slaude.homeClaim" -}}
{{- .Values.home.existingClaim | default .Values.home.claimName | default (printf "%s-home" (include "slaude.fullname" .)) -}}
{{- end -}}

{{- define "slaude.configName" -}}
{{- .Values.scale.names.config | default (printf "%s-config" (include "slaude.fullname" .)) -}}
{{- end -}}
{{- define "slaude.gatewayConfigName" -}}
{{- .Values.scale.names.gatewayConfig | default (printf "%s-gateway-config" (include "slaude.fullname" .)) -}}
{{- end -}}
{{- define "slaude.nodeManifestName" -}}
{{- .Values.scale.names.nodeManifest | default (printf "%s-node-manifest" (include "slaude.fullname" .)) -}}
{{- end -}}
{{- define "slaude.gatewayName" -}}
{{- printf "%s-gateway" (include "slaude.fullname" .) -}}
{{- end -}}

{{/* A node entry's Deployment name and component. Call with (dict "root" $ "node" $n). */}}
{{- define "slaude.nodeName" -}}
{{- if eq .node.label "default" -}}
{{- printf "%s-node" (include "slaude.fullname" .root) -}}
{{- else -}}
{{- printf "%s-node-%s" (include "slaude.fullname" .root) .node.label -}}
{{- end -}}
{{- end -}}
{{- define "slaude.nodeComponent" -}}
{{- if eq .node.label "default" -}}node{{- else -}}{{ printf "node-%s" .node.label }}{{- end -}}
{{- end -}}

{{/* The BullMQ queue a label consumes (src/queue/keys.ts, labelTurnsQueue). */}}
{{- define "slaude.labelQueue" -}}
{{- if eq . "default" -}}turns{{- else -}}{{ printf "turns.label.%s" . }}{{- end -}}
{{- end -}}

{{/* Sandbox mode and git push settings, as container env entries. */}}
{{- define "slaude.sandboxEnv" -}}
{{- with .Values.sandbox }}
{{- if .mcpUrl }}
- name: SLAUDE_SANDBOX
  value: "1"
- name: SLAUDE_SANDBOX_MCP_URL
  value: {{ .mcpUrl | quote }}
{{- if .tokenSecretRef.name }}
- name: SLAUDE_SANDBOX_MCP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .tokenSecretRef.name }}
      key: {{ .tokenSecretRef.key }}
{{- end }}
{{- with .root }}
- name: SLAUDE_SANDBOX_ROOT
  value: {{ . | quote }}
{{- end }}
{{- with .autoUsers }}
- name: SLAUDE_SANDBOX_AUTO_USERS
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .gitPushBranchPattern }}
- name: SLAUDE_GIT_PUSH_BRANCH_PATTERN
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{/* The agent API client registry mount, for the gateway or the mono pod. */}}
{{- define "slaude.agentApiMount" -}}
{{- if .Values.agentApi.enabled }}
- name: api-clients
  mountPath: {{ printf "%s/api-clients" .Values.home.mountPath }}
  readOnly: true
{{- end }}
{{- end -}}
{{- define "slaude.agentApiVolume" -}}
{{- if .Values.agentApi.enabled }}
- name: api-clients
  configMap:
    name: {{ required "agentApi.clientsConfigMap is required when agentApi.enabled" .Values.agentApi.clientsConfigMap }}
{{- end }}
{{- end -}}

{{/* Pod-level scheduling and security settings shared by every slaude pod. */}}
{{- define "slaude.podExtras" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . }}
{{- end }}
{{- with .Values.podSecurityContext }}
securityContext:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
{{ toYaml . }}
{{- end }}
{{- with .Values.affinity }}
affinity:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}
