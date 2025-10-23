import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json()); // gør at vi kan læse JSON body

// ✅ Root check (til test i browser)
app.get("/", (req, res) => {
  res.json({ status: "API running" });
});

// ✅ Base44 job endpoint
app.post("/jobs", (req, res) => {
  const job = req.body;

  // Lav et lille job-ID og timestamp
  const jobId = Math.floor(Math.random() * 1000000);
  const timestamp = new Date().toISOString();

  console.log("🚀 New Base44 job received:");
  console.log(JSON.stringify(job, null, 2));

  // Her kan du senere sende job-data videre til TikTok API eller en database
  // fx await sendToTikTok(job);

  res.json({
    success: true,
    message: "Job received successfully",
    jobId,
    timestamp,
    received: job,
  });
});

// ✅ Catch-all til debugging
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// ✅ Start serveren
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server on ${PORT}`);
});
