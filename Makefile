.PHONY: help install build clean dev cli-help lint typecheck test test-e2e-cli check db-migrate install-cli relink-cli native-rebuild native-check release-verify

help:
	@printf '%s\n' \
	  'make install      # 安装依赖 (install dependencies)' \
	  'make build        # 构建产物 (build artifacts)' \
	  'make clean        # 清理 dist (clean dist)' \
	  'make dev          # 启动 CLI 开发入口 (run CLI entrypoint)' \
	  'make cli-help     # 查看 CLI 帮助 (show CLI help)' \
	  'make native-rebuild # 重建原生依赖 (rebuild native dependencies)' \
	  'make native-check   # 校验原生依赖 (verify native dependencies)' \
	  'make lint         # 运行 ESLint' \
	  'make typecheck    # 运行 TypeScript 检查' \
	  'make test         # 运行测试 (run tests)' \
	  'make test-e2e-cli # 运行 CLI 全命令 e2e 回归 (run CLI full-command e2e regression)' \
	  'make check        # 运行完整质量门 (run quality gates)' \
	  'make release-verify # 运行发布前校验 (run release verification)' \
	  'make db-migrate   # 执行数据库迁移 (run DB migration)' \
	  'make install-cli  # 单命令安装并链接本地 CLI (one-command install and link local CLI)' \
	  'make relink-cli   # 重建并重链本地 CLI (rebuild and relink local CLI)'

install:
	pnpm run install:deps

build:
	pnpm run build

clean:
	pnpm run clean

dev:
	pnpm run dev

cli-help:
	pnpm run cli:help

native-rebuild:
	pnpm run native:rebuild

native-check:
	pnpm run native:check

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

test:
	pnpm run test

test-e2e-cli:
	pnpm run test:e2e-cli

check:
	pnpm run check

release-verify:
	pnpm run release:verify

db-migrate:
	pnpm run db:migrate

install-cli:
	pnpm run install:cli

relink-cli:
	pnpm run relink:cli