const crypto = require('crypto');
const { xdr, Address, nativeToScVal } = require('@stellar/stellar-sdk');

// Input: array of objects { address: "G...", amount: "100" (string for i128) }
// Output: root hash, and array of proofs

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

function bufferCompare(a, b) {
    return a.compare(b);
}

function computeLeaf(userStr, amountStr) {
    const userScVal = new Address(userStr).toScVal();
    const amountScVal = nativeToScVal(amountStr, { type: 'i128' });
    const payload = Buffer.concat([
        userScVal.toXDR(),
        amountScVal.toXDR()
    ]);
    return sha256(payload);
}

function buildTree(leaves) {
    let currentLevel = leaves.map(leaf => leaf).sort(bufferCompare);
    
    // For storing intermediate nodes to build proofs if needed
    // In a simpler way, let's just generate the root for now,
    // and for proofs, we track paths.
    
    // But since the contract does sorted hash pairs:
    // H(a, b) = sha256(min(a,b) + max(a,b))
    
    // A proper Merkle tree builder:
    const tree = [currentLevel];
    while (currentLevel.length > 1) {
        const nextLevel = [];
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left; // duplicate last if odd
            
            const pair = [left, right].sort(bufferCompare);
            nextLevel.push(sha256(Buffer.concat(pair)));
        }
        tree.push(nextLevel);
        currentLevel = nextLevel;
    }
    return tree;
}

function getProof(tree, leaf) {
    let currentHash = leaf;
    const proof = [];
    
    for (let i = 0; i < tree.length - 1; i++) {
        const level = tree[i];
        let index = level.findIndex(h => h.equals(currentHash));
        
        let siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
        if (siblingIndex >= level.length) siblingIndex = index; // odd node duplicated
        
        const sibling = level[siblingIndex];
        proof.push(sibling);
        
        const pair = [currentHash, sibling].sort(bufferCompare);
        currentHash = sha256(Buffer.concat(pair));
    }
    
    return proof;
}

function generateMerkleData(users) {
    const leaves = users.map(u => computeLeaf(u.address, u.amount));
    const tree = buildTree(leaves);
    const root = tree[tree.length - 1][0];
    
    const proofs = users.map((u, i) => {
        return {
            address: u.address,
            amount: u.amount,
            proof: getProof(tree, leaves[i]).map(p => p.toString('hex'))
        };
    });
    
    return {
        root: root.toString('hex'),
        proofs
    };
}

module.exports = { generateMerkleData };

// Example usage if run directly:
if (require.main === module) {
    const sampleUsers = [
        { address: "GBXGQJWVNSR53ZV57XG5Y46L242H3K2L6T2M6V2K5M7W4V3R7I3V4Y4X", amount: "100" },
        { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", amount: "50" }
    ];
    const data = generateMerkleData(sampleUsers);
    console.log(JSON.stringify(data, null, 2));
}
