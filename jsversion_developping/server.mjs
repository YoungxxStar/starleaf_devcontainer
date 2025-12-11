// server.mjs —— LaTeX MCP 服务：同时支持 stdio + HTTP /mcp
import express from "express";   // ⭐ 新增
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
// import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { randomUUID } from "crypto";

// 如果你在 ESM 里需要 __dirname，可以这样算：
const __dirname = path.dirname(new URL(import.meta.url).pathname);

// 你的工作空间根目录（dev container 里就是 /workspaces）
const WORKSPACE_ROOT = "/workspaces";

// --------- 工具函数 -----------------------------------------------------

function resolveWorkspacePath(p) {
    const abs = path.isAbsolute(p)
        ? path.resolve(p)
        : path.resolve(WORKSPACE_ROOT, p);

    const normalizedRoot = path.resolve(WORKSPACE_ROOT) + path.sep;
    if (!abs.startsWith(normalizedRoot)) {
        throw new Error(`Path ${abs} is outside workspace root ${WORKSPACE_ROOT}`);
    }
    return abs;
}

function runCommand(cmd, cwd) {
    return new Promise((resolve) => {
        exec(
            cmd,
            { cwd, maxBuffer: 20 * 1024 * 1024, shell: "/bin/bash" },
            (error, stdout, stderr) => {
                let log = `> ${cmd}\n\n`;
                log += stdout || "";
                log += stderr || "";

                if (error) {
                    log += `\n\n[latex-mcp] Command exited with code ${error.code ?? "unknown"
                        }\n`;
                }

                resolve(log);
            }
        );
    });
}

// --------- 创建 MCP Server & 注册工具 -----------------------------------

const server = new McpServer(
    {
        name: "latex-compiler",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Tool 1: build_latex  —— 编译 .tex（模拟 VS Code latexmk 行为）
server.tool(
    "build_latex",
    {
        file: z
            .string()
            .describe(
                "Path to the main .tex file, relative to /workspaces or absolute."
            ),
        engine: z
            .enum(["pdflatex", "xelatex", "lualatex"])
            .default("pdflatex")
            .describe("LaTeX engine via latexmk: pdflatex (default) / xelatex / lualatex"),
    },
    async ({ file, engine }) => {
        const absPath = resolveWorkspacePath(file);

        if (!fs.existsSync(absPath)) {
            return {
                content: [
                    {
                        type: "text",
                        text: `ERROR: File not found: ${absPath}`,
                    },
                ],
            };
        }

        const cwd = path.dirname(absPath);
        const filename = path.basename(absPath);

        let engineFlag = "-pdf";
        if (engine === "xelatex") engineFlag = "-pdfxe";
        if (engine === "lualatex") engineFlag = "-pdflua";

        const cmd = [
            "latexmk",
            "-synctex=1",
            "-interaction=nonstopmode",
            "-file-line-error",
            engineFlag,
            `"${filename}"`,
        ].join(" ");

        const log = await runCommand(cmd, cwd);

        const base = path.basename(filename, ".tex");
        const pdfPath = path.join(cwd, `${base}.pdf`);
        const pdfExists = fs.existsSync(pdfPath);

        const summary =
            `build_latex finished.\n\n` +
            `Working directory: ${cwd}\n` +
            `Command: ${cmd}\n` +
            `PDF exists: ${pdfExists ? pdfPath : "NO"}\n\n` +
            `--- Latexmk log ---\n` +
            log;

        return {
            content: [
                {
                    type: "text",
                    text: summary,
                },
            ],
        };
    }
);

// Tool 2: clean_latex —— 清理中间文件
server.tool(
    "clean_latex",
    {
        file: z
            .string()
            .describe("Path to the main .tex file used as target for cleanup."),
        mode: z
            .enum(["aux", "all"])
            .default("aux")
            .describe("aux: latexmk -c; all: latexmk -C (delete pdf as well)."),
    },
    async ({ file, mode }) => {
        const absPath = resolveWorkspacePath(file);

        if (!fs.existsSync(absPath)) {
            return {
                content: [
                    {
                        type: "text",
                        text: `ERROR: File not found: ${absPath}`,
                    },
                ],
            };
        }

        const cwd = path.dirname(absPath);
        const filename = path.basename(absPath);
        const flag = mode === "all" ? "-C" : "-c";

        const cmd = `latexmk ${flag} "${filename}"`;
        const log = await runCommand(cmd, cwd);

        const msg =
            `clean_latex finished.\n` +
            `Mode: ${mode}\n` +
            `Command: ${cmd}\n\n` +
            `--- Latexmk log ---\n` +
            log;

        return {
            content: [
                {
                    type: "text",
                    text: msg,
                },
            ],
        };
    }
);

// Tool 3: read_latex_log —— 读取 .log 内容
server.tool(
    "read_latex_log",
    {
        file: z
            .string()
            .describe("Path to the main .tex file whose .log should be read."),
    },
    async ({ file }) => {
        const absPath = resolveWorkspacePath(file);
        const cwd = path.dirname(absPath);
        const base = path.basename(absPath, ".tex");
        const logPath = path.join(cwd, `${base}.log`);

        if (!fs.existsSync(logPath)) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Log file not found: ${logPath}\nYou may need to run build_latex first.`,
                    },
                ],
            };
        }

        const content = fs.readFileSync(logPath, "utf-8");
        return {
            content: [
                {
                    type: "text",
                    text: `Log path: ${logPath}\n\n${content}`,
                },
            ],
        };
    }
);

// --------- 启动 stdio + HTTP /mcp 双模式 ---------------------------------

async function startStdioTransport() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[latex-mcp-server] STDIO transport ready");
}

// HTTP MCP（Streamable HTTP）—— 类似 Context7 的远程 HTTP MCP
async function startHttpTransport() {
    // MCP 规范推荐使用单个 /mcp endpoint，支持 POST/GET/DELETE
    const app = express();
    app.use(express.json());   // <--- 新增
    // sessionId -> transport 映射（一个会话一个 StreamableHTTPServerTransport）
    /** @type {Record<string, StreamableHTTPServerTransport>} */
    const transports = {};

    // POST /mcp 处理 JSON-RPC 请求（宽松版：没 sessionId 一律当新会话）
    const mcpPostHandler = async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];

        try {
            let transport;

            if (sessionId && transports[sessionId]) {
                // 已有会话：复用同一个 transport
                transport = transports[sessionId];
            } else if (!sessionId) {
                // 没有 sessionId：一律当“新建会话”
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (sid) => {
                        console.log(`[http] MCP session initialized: ${sid}`);
                        transports[sid] = transport;
                    },
                });

                // 关闭时清理
                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && transports[sid]) {
                        console.log(`[http] MCP session closed: ${sid}`);
                        delete transports[sid];
                    }
                };

                // 连接 MCP server
                await server.connect(transport);
            } else {
                // 带了 sessionId 但我们这边没记录
                res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: Unknown session ID",
                    },
                    id: null,
                });
                return;
            }

            // 把这次请求交给 transport 处理（包括 initialize / tools.list 等）
            await transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error("[latex-mcp-server][http] Error handling POST /mcp:", err);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    };


    // GET /mcp —— SSE 通道（可选，但很多客户端会用）
    const mcpGetHandler = async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];

        if (!sessionId || !transports[sessionId]) {
            res.status(400).send("Invalid or missing session ID");
            return;
        }

        const transport = transports[sessionId];
        try {
            await transport.handleRequest(req, res);
        } catch (err) {
            console.error("[latex-mcp-server][http] Error handling GET /mcp:", err);
            if (!res.headersSent) {
                res.status(500).send("Internal server error");
            }
        }
    };

    // DELETE /mcp —— 结束会话
    const mcpDeleteHandler = async (req, res) => {
        const sessionId = req.headers["mcp-session-id"];

        if (!sessionId || !transports[sessionId]) {
            res.status(400).send("Invalid or missing session ID");
            return;
        }

        const transport = transports[sessionId];

        try {
            await transport.handleRequest(req, res);
        } catch (err) {
            console.error(
                "[latex-mcp-server][http] Error handling DELETE /mcp:",
                err
            );
            if (!res.headersSent) {
                res.status(500).send("Internal server error");
            }
        }
    };

    app.post("/mcp", mcpPostHandler);
    app.get("/mcp", mcpGetHandler);
    app.delete("/mcp", mcpDeleteHandler);

    const MCP_PORT = process.env.MCP_PORT
        ? parseInt(process.env.MCP_PORT, 10)
        : 5000;

    app.listen(MCP_PORT, (err) => {
        if (err) {
            console.error("[latex-mcp-server] Failed to start HTTP server:", err);
            process.exit(1);
        }
        console.log(
            `[latex-mcp-server] HTTP MCP server listening on http://0.0.0.0:${MCP_PORT}/mcp`
        );
    });

    // 优雅退出
    process.on("SIGINT", async () => {
        console.log("[latex-mcp-server] Shutting down HTTP server...");
        for (const sid of Object.keys(transports)) {
            try {
                await transports[sid].close();
            } catch (e) {
                console.error(`Error closing transport for session ${sid}:`, e);
            }
        }
        process.exit(0);
    });
}

async function main() {
    // 同时启动 stdio + HTTP MCP
    // - 本地 MCP host 可以用 stdio 模式（spawn 这个进程）
    // - 远程 / 其他 host 可以用 HTTP 模式连 http://host:4000/mcp
    await startStdioTransport();
    await startHttpTransport();

    console.error("[latex-mcp-server] LaTeX MCP server ready (stdio + http)");
}

main().catch((err) => {
    console.error("[latex-mcp-server] Fatal error:", err);
    process.exit(1);
});
