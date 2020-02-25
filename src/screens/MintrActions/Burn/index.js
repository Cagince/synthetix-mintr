import React, { useContext, useState, useEffect, useCallback } from 'react';

import Action from './Action';
import Confirmation from './Confirmation';
import Complete from './Complete';

import snxJSConnector from '../../../helpers/snxJSConnector';
import { SliderContext } from '../../../components/ScreenSlider';
import { Store } from '../../../store';
import { bytesFormatter, bigNumberFormatter, formatCurrency } from '../../../helpers/formatters';
import { GWEI_UNIT } from '../../../helpers/networkHelper';
import errorMapper from '../../../helpers/errorMapper';
import { createTransaction } from '../../../ducks/transactions';
import { updateGasLimit, fetchingGasLimit } from '../../../ducks/network';
import { useTranslation } from 'react-i18next';

const useGetDebtData = (walletAddress, sUSDBytes) => {
	const [data, setData] = useState({});
	const SNXBytes = bytesFormatter('SNX');
	useEffect(() => {
		const getDebtData = async () => {
			try {
				const results = await Promise.all([
					snxJSConnector.snxJS.Synthetix.debtBalanceOf(walletAddress, sUSDBytes),
					snxJSConnector.snxJS.sUSD.balanceOf(walletAddress),
					snxJSConnector.snxJS.SynthetixState.issuanceRatio(),
					snxJSConnector.snxJS.ExchangeRates.rateForCurrency(SNXBytes),
					snxJSConnector.snxJS.RewardEscrow.totalEscrowedAccountBalance(walletAddress),
					snxJSConnector.snxJS.SynthetixEscrow.balanceOf(walletAddress),
					snxJSConnector.snxJS.Synthetix.collateralisationRatio(walletAddress),
					snxJSConnector.snxJS.Synthetix.maxIssuableSynths(walletAddress),
				]);
				const [
					debt,
					sUSDBalance,
					issuanceRatio,
					SNXPrice,
					totalRewardEscrow,
					totalTokenSaleEscrow,
					cRatio,
					issuableSynths,
					waitingPeriod,
				] = results.map(bigNumberFormatter);
				let maxBurnAmount, maxBurnAmountBN;
				if (debt > sUSDBalance) {
					maxBurnAmount = sUSDBalance;
					maxBurnAmountBN = results[1];
				} else {
					maxBurnAmount = debt;
					maxBurnAmountBN = results[0];
				}

				setData({
					issuanceRatio,
					sUSDBalance,
					maxBurnAmount,
					maxBurnAmountBN,
					SNXPrice,
					escrowBalance: totalRewardEscrow + totalTokenSaleEscrow,
					cRatio,
					burnAmountToFixCRatio: Math.max(debt - issuableSynths, 0),
					waitingPeriod,
				});
			} catch (e) {
				console.log(e);
			}
		};
		getDebtData();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [walletAddress]);
	return data;
};

const useGetGasEstimate = (
	burnAmount,
	maxBurnAmount,
	maxBurnAmountBN,
	sUSDBalance,
	waitingPeriod
) => {
	const { dispatch } = useContext(Store);
	const [error, setError] = useState(null);
	const { t } = useTranslation();
	useEffect(() => {
		if (!burnAmount) return;
		const getGasEstimate = async () => {
			setError(null);
			let gasEstimate;
			try {
				if (!parseFloat(burnAmount)) throw new Error('input.error.invalidAmount');
				if (waitingPeriod) throw new Error('Waiting period for sUSD is still ongoing');
				if (burnAmount > sUSDBalance || maxBurnAmount === 0)
					throw new Error('input.error.notEnoughToBurn');
				fetchingGasLimit(dispatch);

				let amountToBurn;
				if (burnAmount && maxBurnAmount) {
					amountToBurn =
						burnAmount === maxBurnAmount
							? maxBurnAmountBN
							: snxJSConnector.utils.parseEther(burnAmount.toString());
				} else amountToBurn = 0;

				gasEstimate = await snxJSConnector.snxJS.Synthetix.contract.estimate.burnSynths(
					amountToBurn
				);
			} catch (e) {
				console.log(e);
				const errorMessage = (e && e.message) || 'input.error.gasEstimate';
				setError(t(errorMessage));
			}
			updateGasLimit(Number(gasEstimate), dispatch);
		};
		getGasEstimate();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [burnAmount, maxBurnAmount, waitingPeriod]);
	return error;
};

const Burn = ({ onDestroy }) => {
	const { handleNext, handlePrev } = useContext(SliderContext);
	const [burnAmount, setBurnAmount] = useState('');
	const [transferableAmount, setTransferableAmount] = useState('');
	const [transactionInfo, setTransactionInfo] = useState({});
	const [waitingPeriod, setWaitingPeriod] = useState(0);
	const {
		state: {
			wallet: { currentWallet, walletType, networkName },
			network: {
				settings: { gasPrice, gasLimit, isFetchingGasLimit },
			},
		},
		dispatch,
	} = useContext(Store);

	const sUSDBytes = bytesFormatter('sUSD');
	const {
		maxBurnAmount,
		maxBurnAmountBN,
		sUSDBalance,
		issuanceRatio,
		SNXPrice,
		escrowBalance,
		cRatio,
		burnAmountToFixCRatio,
	} = useGetDebtData(currentWallet, sUSDBytes);

	const getMaxSecsLeftInWaitingPeriod = useCallback(async () => {
		try {
			const maxSecsLeftInWaitingPeriod = await snxJSConnector.snxJS.Exchanger.maxSecsLeftInWaitingPeriod(
				currentWallet,
				bytesFormatter('sUSD')
			);
			setWaitingPeriod(Number(maxSecsLeftInWaitingPeriod));
		} catch (e) {
			console.log(e);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [burnAmount]);

	useEffect(() => {
		getMaxSecsLeftInWaitingPeriod();
	}, [getMaxSecsLeftInWaitingPeriod]);

	const gasEstimateError = useGetGasEstimate(
		burnAmount,
		maxBurnAmount,
		maxBurnAmountBN,
		sUSDBalance,
		waitingPeriod
	);
	const onBurn = async () => {
		try {
			if (await snxJSConnector.snxJS.Synthetix.isWaitingPeriod(bytesFormatter('sUSD')))
				throw new Error('Waiting period for sUSD is still ongoing');

			handleNext(1);
			const amountToBurn =
				burnAmount === maxBurnAmount
					? maxBurnAmountBN
					: snxJSConnector.utils.parseEther(burnAmount.toString());
			const transaction = await snxJSConnector.snxJS.Synthetix.burnSynths(amountToBurn, {
				gasPrice: gasPrice * GWEI_UNIT,
				gasLimit,
				nonce: 1,
			});
			if (transaction) {
				setTransactionInfo({ transactionHash: transaction.hash });
				createTransaction(
					{
						hash: transaction.hash,
						status: 'pending',
						info: `Burning ${formatCurrency(burnAmount)} sUSD`,
						hasNotification: true,
					},
					dispatch
				);
				handleNext(2);
			}
		} catch (e) {
			console.log(e);
			const errorMessage = errorMapper(e, walletType);
			console.log(errorMessage);
			setTransactionInfo({
				...transactionInfo,
				transactionError: errorMessage,
			});
			handleNext(2);
		}
	};

	const props = {
		onDestroy,
		onBurn,
		goBack: handlePrev,
		maxBurnAmount,
		issuanceRatio,
		...transactionInfo,
		burnAmount,
		setBurnAmount: amount => {
			const amountNB = Number(amount);
			setBurnAmount(amount);
			setTransferableAmount(
				amountNB ? Math.max(amountNB / cRatio / SNXPrice - escrowBalance, 0) : 0
			);
		},
		transferableAmount,
		setTransferableAmount: amount => {
			const amountNB = Number(amount);
			setBurnAmount(amountNB > 0 ? (escrowBalance + amountNB) * issuanceRatio * SNXPrice : '');
			setTransferableAmount(amount);
		},
		walletType,
		networkName,
		SNXPrice,
		isFetchingGasLimit,
		gasEstimateError,
		burnAmountToFixCRatio,
		waitingPeriod,
		onWaitingPeriodCheck: () => getMaxSecsLeftInWaitingPeriod(),
	};

	return [Action, Confirmation, Complete].map((SlideContent, i) => (
		<SlideContent key={i} {...props} />
	));
};

export default Burn;
