import express from "express";
import cors from "cors";

const app = express();
app.use(cors());              // vigtigt for Base44 i browseren
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "API running" }));

// Opret job
app.post("/jobs", (req, res) => {
  const { source_url, variations = 5, preset = "poc_v1", accounts = [] } = req.body || {};
  const job_id = "job_" + Math.random().toString(36).slice(2, 9);
  // returnér queued – Base44 kan vise progress på baggrund af status endpoint
  res.status(201).json({ job_id, state: "queued", received: { source_url, variations, preset, accounts } });
});

// Status for job
app.get("/jobs/:job_id", (req, res) => {
  // POC: fake progression/outputs
  const { job_id } = req.params;
  res.json({
    job_id,
    state: "complete",
    progress: 100,
    outputs: [
      { id: 1, url: "https://files.example.com/clip_v1.mp4", caption: "Hook v1", hashtags: ["#europesnus","#push"] },
      { id: 2, url: "https://files.example.com/clip_v2.mp4", caption: "Hook v2", hashtags: ["#europesnus","#push"] }
    ]
  });
});

const PORT = process.env.PORT || 10000; // Render giver en PORT var
app.listen(PORT, () => console.log("Server on", PORT));
