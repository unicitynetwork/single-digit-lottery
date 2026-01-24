import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  nametag: string; // Nostr nametag for receiving/sending tokens
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    nametag: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

export const User = mongoose.model<IUser>('User', userSchema);
