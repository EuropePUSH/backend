import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "API running" });
});

app.post("/jobs", (req, res) => {
  const { source_url, variations } = req.body;
  res.json({
    job_id: "job_" + Math.random().toString(36).substring(2, 9),
    state: "queued",
    message: `Simulating ${variations || 5} variations from ${source_url || "dummy.mp4"}`
  });
});

app.get("/status/:job_id", (req, res) => {
  res.json({
    job_id: req.params.job_id,
    state: "complete",
    progress: 100,
    outputs: [
      { id: 1, url: "https://example.com/video1.mp4", caption: "Test caption", hashtags: ["#europesnus", "#foryou"] },
      { id: 2, url: "https://example.com/video2.mp4", caption: "Another one", hashtags: ["#iceberg", "#stayawake"] }
    ]
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
