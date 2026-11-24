{{- define "sandbox.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "sandbox.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "sandbox.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "sandbox.selector" -}}
app.kubernetes.io/name: {{ include "sandbox.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "sandbox.labels" -}}
{{ include "sandbox.selector" . }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Where the k8s backend creates sandboxes. */}}
{{- define "sandbox.podNamespace" -}}
{{- .Values.k8s.namespace | default .Release.Namespace -}}
{{- end -}}

{{- define "sandbox.mirrorsClaim" -}}
{{- .Values.mirrors.persistence.existingClaim | default (printf "%s-mirrors" (include "sandbox.fullname" .)) -}}
{{- end -}}
