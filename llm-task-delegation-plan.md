# Plano: LLM Task Delegation + PR Quality Gates

## Componentes

### 1. Card System
- GitHub Issues como cards
- Template obrigatório: contexto, critérios de aceite, escopo fora
- Label `agent-ready` para sinalizar tarefa pronta

### 2. Agent Executor
- Claude Code CLI via GitHub Actions
- Cria branch, commita, abre PR linkando o issue
- CLAUDE.md no repositório como contexto do projeto

### 3. Quality Gates no PR
- Nível 1 — Automático: lint, type check, testes
- Nível 2 — Agent Review: lê diff e verifica critérios do card
- Nível 3 — Human Review: aprovação humana antes do merge

## Fases

### Fase 1 — MVP
- Template de issue no GitHub
- Script local que lê o issue e chama `claude` CLI
- PR aberto pelo agente
- CI básico (lint + testes)

### Fase 2 — Automação
- GitHub Action escuta label `agent-ready`
- Agent executa e abre PR automaticamente
- Agent reviewer comenta no PR com checklist dos critérios

### Fase 3 — Refinamento
- Métricas: taxa de aprovação no primeiro review, retrabalho humano
- Ajuste dos templates baseado nos erros mais comuns
- Scoring de qualidade do card antes de disparar o agente

## Stack

| Peça             | Ferramenta           |
|------------------|----------------------|
| Cards            | GitHub Issues        |
| CI/CD            | GitHub Actions       |
| Agent executor   | Claude Code CLI      |
| Agent reviewer   | Claude API (Sonnet)  |
| Repositório      | Git                  |

## Decisões Pendentes

1. Que tipo de tarefa será delegada? (bugfix, feature, docs, testes?)
2. Repositório existente ou novo projeto?
3. Quanto de autonomia o agente tem?
4. Quem é o revisor humano final?
