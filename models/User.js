const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
        select: false
    },
    role: {
        type: String,
        enum: ['Admin', 'Approver', 'Planner', 'Viewer'], 
        default: 'Viewer'
    },
    status: {
        type: String,
        default: 'active'
    },
    permissions: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    lastActive: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

// Pre-save hook to hash password before saving if modified
userSchema.pre('save', async function() {
    if (!this.isModified('password')) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
});

// Method to safely compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
    if (!this.password) return false;
    return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);