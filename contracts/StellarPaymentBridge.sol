// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title StellarPaymentBridge
 * @notice Bridge contract for sending payments from Ethereum to Stellar via Axelar
 * @dev Integrates with Axelar's General Message Passing (GMP) protocol
 */

interface IAxelarGateway {
    function callContract(
        string calldata destinationChain,
        string calldata contractAddress,
        bytes calldata payload
    ) external;
}

interface IAxelarGasService {
    function payNativeGasForContractCall(
        address sender,
        string calldata destinationChain,
        string calldata destinationAddress,
        bytes calldata payload,
        address refundAddress
    ) external payable;
}

contract StellarPaymentBridge {
    IAxelarGateway public immutable gateway;
    IAxelarGasService public immutable gasService;
    
    string public constant STELLAR_CHAIN = "stellar";
    string public stellarRouterAddress;
    address public owner;
    
    event PaymentBridged(
        address indexed sender,
        string recipientOnStellar,
        string tokenOnStellar,
        uint128 amount,
        string memo,
        uint256 gasPaid
    );
    
    event RouterUpdated(string newRouter);
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    /**
     * @notice Constructor
     * @param _gateway Axelar Gateway contract address
     * @param _gasService Axelar Gas Service contract address
     * @param _stellarRouter Payment router contract address on Stellar
     */
    constructor(
        address _gateway,
        address _gasService,
        string memory _stellarRouter
    ) {
        require(_gateway != address(0), "Invalid gateway");
        require(_gasService != address(0), "Invalid gas service");
        
        gateway = IAxelarGateway(_gateway);
        gasService = IAxelarGasService(_gasService);
        stellarRouterAddress = _stellarRouter;
        owner = msg.sender;
    }
    
    /**
     * @notice Bridge a payment from Ethereum to Stellar
     * @param recipientAddress Recipient address on Stellar network
     * @param tokenAddress Token contract address on Stellar
     * @param amount Amount to send (in token's smallest unit)
     * @param memo Optional payment memo/note
     */
    function bridgePayment(
        string calldata recipientAddress,
        string calldata tokenAddress,
        uint128 amount,
        string calldata memo
    ) external payable {
        require(amount > 0, "Amount must be positive");
        require(bytes(recipientAddress).length > 0, "Invalid recipient");
        require(bytes(tokenAddress).length > 0, "Invalid token");
        require(msg.value > 0, "Must pay gas");
        
        // Encode payload for Stellar payment router
        bytes memory payload = encodePayload(
            recipientAddress,
            tokenAddress,
            amount,
            addressToString(msg.sender),
            "ethereum",
            memo
        );
        
        // Pay for gas on destination chain
        gasService.payNativeGasForContractCall{value: msg.value}(
            address(this),
            STELLAR_CHAIN,
            stellarRouterAddress,
            payload,
            msg.sender
        );
        
        // Send cross-chain message via Axelar
        gateway.callContract(
            STELLAR_CHAIN,
            stellarRouterAddress,
            payload
        );
        
        emit PaymentBridged(
            msg.sender,
            recipientAddress,
            tokenAddress,
            amount,
            memo,
            msg.value
        );
    }
    
    /**
     * @notice Encode payment payload according to Stellar router format
     * @dev Format: recipient(32)|token(32)|amount(16)|sender_len(2)|sender|chain_len(2)|chain|memo
     */
    function encodePayload(
        string memory recipient,
        string memory token,
        uint128 amount,
        string memory sender,
        string memory chain,
        string memory memo
    ) internal pure returns (bytes memory) {
        bytes memory recipientBytes = bytes(recipient);
        bytes memory tokenBytes = bytes(token);
        bytes memory senderBytes = bytes(sender);
        bytes memory chainBytes = bytes(chain);
        bytes memory memoBytes = bytes(memo);
        
        // Calculate total size
        uint256 totalSize = 32 + 32 + 16 + 2 + senderBytes.length + 2 + chainBytes.length + memoBytes.length;
        bytes memory payload = new bytes(totalSize);
        uint256 offset = 0;
        
        // Recipient (32 bytes, padded)
        for (uint256 i = 0; i < 32 && i < recipientBytes.length; i++) {
            payload[offset + i] = recipientBytes[i];
        }
        offset += 32;
        
        // Token (32 bytes, padded)
        for (uint256 i = 0; i < 32 && i < tokenBytes.length; i++) {
            payload[offset + i] = tokenBytes[i];
        }
        offset += 32;
        
        // Amount (16 bytes, big-endian)
        for (uint256 i = 0; i < 16; i++) {
            payload[offset + 15 - i] = bytes1(uint8(amount >> (i * 8)));
        }
        offset += 16;
        
        // Sender length (2 bytes)
        payload[offset] = bytes1(uint8(senderBytes.length >> 8));
        payload[offset + 1] = bytes1(uint8(senderBytes.length));
        offset += 2;
        
        // Sender
        for (uint256 i = 0; i < senderBytes.length; i++) {
            payload[offset + i] = senderBytes[i];
        }
        offset += senderBytes.length;
        
        // Chain length (2 bytes)
        payload[offset] = bytes1(uint8(chainBytes.length >> 8));
        payload[offset + 1] = bytes1(uint8(chainBytes.length));
        offset += 2;
        
        // Chain
        for (uint256 i = 0; i < chainBytes.length; i++) {
            payload[offset + i] = chainBytes[i];
        }
        offset += chainBytes.length;
        
        // Memo
        for (uint256 i = 0; i < memoBytes.length; i++) {
            payload[offset + i] = memoBytes[i];
        }
        
        return payload;
    }
    
    /**
     * @notice Convert address to hex string
     */
    function addressToString(address _addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory data = abi.encodePacked(_addr);
        bytes memory str = new bytes(2 + data.length * 2);
        
        str[0] = '0';
        str[1] = 'x';
        
        for (uint256 i = 0; i < data.length; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        
        return string(str);
    }
    
    /**
     * @notice Update Stellar router address (owner only)
     * @param newRouter New router contract address on Stellar
     */
    function updateStellarRouter(string calldata newRouter) external onlyOwner {
        require(bytes(newRouter).length > 0, "Invalid router");
        stellarRouterAddress = newRouter;
        emit RouterUpdated(newRouter);
    }
    
    /**
     * @notice Transfer ownership (owner only)
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        owner = newOwner;
    }
    
    /**
     * @notice Estimate gas payment needed for cross-chain call
     * @dev This is a rough estimate, actual cost may vary
     */
    function estimateGasPayment() external pure returns (uint256) {
        // Typical cross-chain gas cost
        return 0.01 ether; // Adjust based on current gas prices
    }
}
