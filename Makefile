.PHONY: help install build clean dev cli-help lint typecheck test check db-migrate install-cli relink-cli

help:
	@printf '%s\n' \
	  'make install      # 安装依赖 (install dependencies)' \
	  'make build        # 构建产物 (build artifacts)' \
	  'make clean        # 清理 dist (clean dist)' \
	  'make dev          # 启动 CLI 开发入口 (run CLI entrypoint)' \
	  'make cli-help     # 查看 CLI 帮助 (show CLI help)' \
	  'make lint         # 运行 ESLint' \
	  'make typecheck    # 运行 TypeScript 检查' \
	  'make test         # 运行测试 (run tests)' \
	  'make check        # 运行完整质量门 (run quality gates)' \
	  'make db-migrate   # 执行数据库迁移 (run DB migration)' \
	  'make install-cli  # 安装并链接本地 CLI (install and link local CLI)' \
	  'make relink-cli   # 重建并重链本地 CLI (rebuild and relink local CLI)'

install:
	pnpm install

build:
	pnpm run build

clean:
	pnpm run clean

dev:
	pnpm run dev

cli-help:
	pnpm run cli:help

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

test:
	pnpm run test

check:
	pnpm run check

db-migrate:
	pnpm run db:migrate

install-cli:
	pnpm run install:cli

relink-cli:
	pnpm run relink:cli