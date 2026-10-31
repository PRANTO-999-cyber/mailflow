import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

export const ROLE_PERMISSIONS = {
  Owner: ['*'],
  Admin: ['users:read','users:write','campaigns:read','campaigns:write','campaigns:send','recipients:read','recipients:write','templates:read','templates:write','activity:read','settings:read','settings:write','smtp:read','smtp:send'],
  'Campaign Manager': ['campaigns:read','campaigns:write','campaigns:send','recipients:read','templates:read','templates:write','activity:read','smtp:read'],
  Analyst: ['campaigns:read','recipients:read','templates:read','activity:read','settings:read','smtp:read'],
  Support: ['campaigns:read','recipients:read','templates:read','activity:read','settings:read','smtp:read']
};
const userSchema = new mongoose.Schema({
  name: {type:String,required:true,trim:true,maxlength:100},
  email: {type:String,required:true,unique:true,lowercase:true,trim:true,index:true},
  passwordHash: {type:String,required:true,select:false},
  role: {type:String,enum:Object.keys(ROLE_PERMISSIONS),default:'Campaign Manager'},
  active: {type:Boolean,default:true},
  tokenVersion: {type:Number,default:0},
  lastLoginAt: Date
},{timestamps:true});
userSchema.index({ role: 1 }, { unique: true, partialFilterExpression: { role: 'Owner' } });
export const User = mongoose.models.User || mongoose.model('User',userSchema);
export const hashPassword = password => bcrypt.hash(password, 12);
export const checkPassword = (password, hash) => bcrypt.compare(password, hash);
export const signToken = user => jwt.sign({sub:user._id.toString(),ver:user.tokenVersion},process.env.JWT_SECRET,{expiresIn:'8h',issuer:'gmail-mailer',audience:'gmail-mailer-admin'});
export const authMiddleware = async (req,res,next) => {
  try {
    const token = req.cookies?.gm_session || (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    if (!token) return res.status(401).json({error:'Please sign in to continue.'});
    const claims = jwt.verify(token,process.env.JWT_SECRET,{issuer:'gmail-mailer',audience:'gmail-mailer-admin'});
    const user = await User.findById(claims.sub);
    if (!user || !user.active || user.tokenVersion !== claims.ver) return res.status(401).json({error:'Your session is no longer valid. Please sign in again.'});
    req.user = user;
    next();
  } catch { return res.status(401).json({error:'Your session expired. Please sign in again.'}); }
};
export const requirePermission = permission => (req,res,next) => {
  const permissions = ROLE_PERMISSIONS[req.user?.role] || [];
  if (!permissions.includes('*') && !permissions.includes(permission)) return res.status(403).json({error:'You do not have permission to perform this action.'});
  next();
};
export const publicUser = user => ({id:user._id.toString(),name:user.name,email:user.email,role:user.role,permissions:ROLE_PERMISSIONS[user.role]||[],active:user.active,lastLoginAt:user.lastLoginAt||null});
export const newRecoveryCode = () => crypto.randomBytes(24).toString('hex');
