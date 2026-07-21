import "dotenv/config";
// Durable outputs and source images are never deleted here. Temporary attempt keys are safe because no database asset references them.
console.log("R2 lifecycle policy should expire projects/*/renders/*/temporary/* after 24 hours. See docs/production-architecture.md.");
