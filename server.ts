import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import crypto from "crypto";
import { Block, Vote, CANDIDATES } from "./src/types";
import { WebSocketServer, WebSocket } from "ws";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import fs from "fs";

const app = express();
const PORT = 3000;
const dbPath = path.join(__dirname, "blockchain.db");

console.log("--- Environment Diagnostics ---");
console.log("Current Directory:", __dirname);
try {
  fs.writeFileSync(path.join(__dirname, ".write_test"), "test");
  console.log("File System: WRITEABLE");
} catch (e) {
  console.warn("File System: READ-ONLY or Permission Denied");
}

let db: any;
let useMemory = false;

const createInMemoryDb = () => {
  console.log("Initializing IN-MEMORY blockchain storage");
  const storage = {
    blocks: [] as any[],
    prepare: (sql: string) => ({
      get: () => {
        if (sql.includes("COUNT")) return { count: storage.blocks.length };
        if (sql.includes("ORDER BY block_index DESC")) return storage.blocks[storage.blocks.length - 1] || null;
        return null;
      },
      run: (...args: any[]) => {
        if (sql.includes("INSERT")) {
          storage.blocks.push({
            block_index: args[0],
            timestamp: args[1],
            data: args[2],
            previous_hash: args[3],
            hash: args[4],
            nonce: args[5]
          });
        }
        if (sql.includes("DELETE")) {
          storage.blocks = [];
        }
        return { changes: 1 };
      },
      all: () => [...storage.blocks]
    }),
    exec: () => {}
  };
  return storage;
};

try {
  console.log("Attempting to initialize SQLite at:", dbPath);
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_index INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      nonce INTEGER NOT NULL
    )
  `);
  console.log("SQLite: INITIALIZED");
} catch (err) {
  console.error("SQLite initialization failed:", err);
  useMemory = true;
  db = createInMemoryDb();
}

class Blockchain {
  private difficulty = 0;

  constructor() {
    this.ensureGenesis();
  }

  private ensureGenesis() {
    try {
      const count = db.prepare("SELECT COUNT(*) as count FROM blocks").get();
      if (!count || count.count === 0) {
        console.log("Blockchain: Creating genesis block");
        this.createGenesisBlock();
      }
    } catch (err) {
      console.error("Blockchain: Genesis check failed, forcing memory mode", err);
      useMemory = true;
      db = createInMemoryDb();
      this.createGenesisBlock();
    }
  }

  private calculateHash(index: number, previousHash: string, timestamp: number, data: any, nonce: number): string {
    return crypto
      .createHash("sha256")
      .update(index + previousHash + timestamp + JSON.stringify(data) + nonce)
      .digest("hex");
  }

  public createGenesisBlock() {
    const timestamp = Date.now();
    const data = { voterId: "SYSTEM", candidateId: "GENESIS", timestamp };
    const hash = this.calculateHash(0, "0", timestamp, data, 0);
    
    db.prepare(`
      INSERT INTO blocks (block_index, timestamp, data, previous_hash, hash, nonce)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(0, timestamp, JSON.stringify(data), "0", hash, 0);
  }

  private getLatestBlock(): Block {
    const row = db.prepare("SELECT * FROM blocks ORDER BY block_index DESC LIMIT 1").get();
    if (!row) {
      throw new Error("Blockchain is empty and genesis could not be created");
    }
    return {
      index: row.block_index,
      timestamp: row.timestamp,
      data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
      previousHash: row.previous_hash,
      hash: row.hash,
      nonce: row.nonce
    };
  }

  public addVote(vote: Vote): Block {
    try {
      const latestBlock = this.getLatestBlock();
      const index = latestBlock.index + 1;
      const timestamp = Date.now();
      const previousHash = latestBlock.hash;
      const nonce = 0;
      const hash = this.calculateHash(index, previousHash, timestamp, vote, nonce);

      console.log(`Blockchain: Adding block #${index} for voter ${vote.voterId}`);
      
      db.prepare(`
        INSERT INTO blocks (block_index, timestamp, data, previous_hash, hash, nonce)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(index, timestamp, JSON.stringify(vote), previousHash, hash, nonce);

      return { index, timestamp, data: vote, previousHash, hash, nonce };
    } catch (err) {
      console.error("Blockchain: addVote failed", err);
      throw err;
    }
  }

  public getChain(): Block[] {
    try {
      const rows = db.prepare("SELECT * FROM blocks ORDER BY block_index ASC").all();
      return rows.map((row: any) => ({
        index: row.block_index,
        timestamp: row.timestamp,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
        previousHash: row.previous_hash,
        hash: row.hash,
        nonce: row.nonce
      }));
    } catch (e) {
      console.error("Failed to get chain", e);
      return [];
    }
  }

  public validateChain(): boolean {
    const chain = this.getChain();
    for (let i = 1; i < chain.length; i++) {
      const currentBlock = chain[i];
      const previousBlock = chain[i - 1];

      if (currentBlock.hash !== this.calculateHash(currentBlock.index, currentBlock.previousHash, currentBlock.timestamp, currentBlock.data, currentBlock.nonce)) {
        return false;
      }

      if (currentBlock.previousHash !== previousBlock.hash) {
        return false;
      }
    }
    return true;
  }
}

const blockchain = new Blockchain();

let wss: WebSocketServer;

const broadcast = (data: any) => {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

app.use(express.json());

// API Routes
app.get("/api/candidates", (req, res) => {
  res.json(CANDIDATES);
});

app.post("/api/vote", (req, res) => {
  const { candidateId, voterId } = req.body;
  console.log(`API: Vote request received: Voter=${voterId}, Candidate=${candidateId}`);
  
  if (!candidateId || !voterId) {
    return res.status(400).json({ error: "Missing candidateId or voterId" });
  }

  try {
    // Check if voter already voted
    const chain = blockchain.getChain();
    const alreadyVoted = chain.some(block => block.data && block.data.voterId === voterId);
    
    if (alreadyVoted) {
      console.warn(`API: Duplicate vote attempt: ${voterId}`);
      return res.status(403).json({ error: "Voter has already cast a vote" });
    }

    const block = blockchain.addVote({ voterId, candidateId, timestamp: Date.now() });
    console.log(`API: Vote successfully added to blockchain: Block #${block.index}`);
    
    broadcast({ type: "VOTE_CAST", block });
    
    res.json({ success: true, block });
  } catch (err: any) {
    console.error("API: Blockchain error during voting:", err);
    res.status(500).json({ error: `Internal blockchain error: ${err.message || 'Unknown error'}` });
  }
});

app.post("/api/admin/login", (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }
    if (password === "admin123") { // Simple password for demo
      res.json({ success: true, token: "mock-admin-token" });
    } else {
      res.status(401).json({ error: "Incorrect administrative password. Please verify your credentials and ensure Caps Lock is off." });
    }
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "The authentication server is currently unreachable. Please try again in a few minutes." });
  }
});

app.get("/api/admin/stats", (req, res) => {
  // In a real app, we'd verify the token
  const chain = blockchain.getChain();
  const votes = chain.filter(b => b.data.candidateId !== "GENESIS");
  
  const results: Record<string, number> = {};
  CANDIDATES.forEach(c => results[c.id] = 0);
  
  votes.forEach(v => {
    if (results[v.data.candidateId] !== undefined) {
      results[v.data.candidateId]++;
    }
  });

  const totalPossibleVoters = 1000; // Mock total electorate
  const pollingPercentage = (votes.length / totalPossibleVoters) * 100;

  res.json({
    totalVotes: votes.length,
    results,
    pollingPercentage,
    isValid: blockchain.validateChain()
  });
});

app.get("/api/admin/chain", (req, res) => {
  res.json(blockchain.getChain());
});

app.post("/api/admin/validate", (req, res) => {
  try {
    const isValid = blockchain.validateChain();
    console.log(`Manual blockchain validation triggered. Result: ${isValid ? 'VALID' : 'INVALID'}`);
    res.json({ success: true, isValid, timestamp: Date.now() });
  } catch (err) {
    console.error("Manual validation error:", err);
    res.status(500).json({ error: "Blockchain validation failed" });
  }
});

app.post("/api/admin/reset", (req, res) => {
  try {
    db.prepare("DELETE FROM blocks").run();
    blockchain.createGenesisBlock(); // Re-create genesis
    
    broadcast({ type: "ELECTION_RESET" });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reset database" });
  }
});

// Global error handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error("Unhandled server error:", err);
  res.status(500).json({ error: "Internal server error. Please try again later." });
});

async function startServer() {
  try {
    if (process.env.NODE_ENV !== "production") {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    }

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });

    wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      console.log("WS: Client connected");
      ws.on("close", () => console.log("WS: Client disconnected"));
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
