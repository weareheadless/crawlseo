-- A delivered opportunity is no longer a to-do; it is work that was done.
ALTER TYPE "OpportunityStatus" ADD VALUE IF NOT EXISTS 'delivered';
