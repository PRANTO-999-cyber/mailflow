import mongoose from 'mongoose';

const deliverySchema = new mongoose.Schema({
  campaignId: { type: String, required: true },
  recipientId: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  provider: { type: String, required: true, default: 'smtp' },
  status: { type: String, enum: ['queued','sending','accepted_by_provider','delivered','deferred','bounced','complained','failed','skipped'], default: 'queued', index: true },
  providerMessageId: String,
  attempts: { type: Number, default: 0 },
  lastError: String,
  acceptedAt: Date,
  deliveredAt: Date,
  leaseAt: Date
}, { timestamps: true });
deliverySchema.index({ campaignId: 1, recipientId: 1 }, { unique: true });
deliverySchema.index({ status: 1, updatedAt: 1 });

const suppressionSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  reason: { type: String, enum: ['unsubscribe','hard_bounce','complaint','manual'], required: true },
  source: String,
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const providerEventSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  providerEventId: { type: String, required: true },
  event: { type: String, required: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  providerMessageId: String,
  occurredAt: Date,
  payload: mongoose.Schema.Types.Mixed
}, { timestamps: true });
providerEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });

export const Delivery = mongoose.models.Delivery || mongoose.model('Delivery', deliverySchema);
export const ProviderEvent = mongoose.models.ProviderEvent || mongoose.model('ProviderEvent', providerEventSchema);
export const Suppression = mongoose.models.Suppression || mongoose.model('Suppression', suppressionSchema);
