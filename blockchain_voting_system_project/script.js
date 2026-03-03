let web3;
let contract;
let account;

// 🔴 PASTE YOUR CONTRACT ADDRESS HERE
const contractAddress = 0xd8b934580fcE35a11B58C6D73aDeE468a2833fa8;

// ABI (do NOT change)
const abi = [
    {
        "inputs": [],
        "name": "getCandidatesCount",
        "outputs": [{"internalType": "uint256","name": "","type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"internalType": "uint256","name": "index","type": "uint256"}],
        "name": "getCandidate",
        "outputs": [
            {"internalType": "string","name": "","type": "string"},
            {"internalType": "uint256","name": "","type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"internalType": "uint256","name": "candidateIndex","type": "uint256"}],
        "name": "vote",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// ✅ CONNECT WALLET
async function connectWallet() {
    if (window.ethereum) {
        try {
            const accounts = await window.ethereum.request({
                method: "eth_requestAccounts"
            });

            account = accounts[0];
            web3 = new Web3(window.ethereum);
            contract = new web3.eth.Contract(abi, contractAddress);

            document.getElementById("walletStatus").innerText =
                "Wallet Connected: " + account;

        } catch (error) {
            alert("Wallet connection rejected");
        }
    } else {
        alert("MetaMask not found. Please install MetaMask.");
    }
}

// ✅ VOTE FUNCTION
async function vote(index) {
    if (!contract) {
        alert("Please connect wallet first");
        return;
    }

    try {
        await contract.methods.vote(index).send({ from: account });
        alert("Vote cast successfully");
    } catch (error) {
        alert("Voting failed or already voted");
    }
}

// ✅ GET RESULTS
async function getResults() {
    if (!contract) {
        alert("Please connect wallet first");
        return;
    }

    let output = "";
    const count = await contract.methods.getCandidatesCount().call();

    for (let i = 0; i < count; i++) {
        const data = await contract.methods.getCandidate(i).call();
        output += `${data[0]} : ${data[1]} votes<br>`;
    }

    document.getElementById("results").innerHTML = output;
}
