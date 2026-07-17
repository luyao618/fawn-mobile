import { Lucide, type LucideIconName } from "@react-native-vector-icons/lucide/static";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer, type Theme } from "@react-navigation/native";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { type Bootstrap, BootstrapHost } from "../features/bootstrap/BootstrapHost";
import { AlbumScreen, GrowthScreen, MeScreen, RecordsScreen, StewardScreen } from "../features/shell/ShellScreens";
import { colors } from "../shared/theme/tokens";
import { ROUTES, type RootTabParamList } from "./routeNames";

const Tab = createBottomTabNavigator<RootTabParamList>();
const navigationTheme: Theme = {
  dark: false,
  colors: { primary: colors.brand, background: colors.canvas, card: colors.surface, text: colors.textPrimary, border: colors.border, notification: colors.danger },
  fonts: {
    regular: { fontFamily: "System", fontWeight: "400" },
    medium: { fontFamily: "System", fontWeight: "500" },
    bold: { fontFamily: "System", fontWeight: "700" },
    heavy: { fontFamily: "System", fontWeight: "700" },
  },
};

const tabs: readonly { name: keyof RootTabParamList; label: string; icon: LucideIconName; component: React.ComponentType }[] = [
  { name: ROUTES.steward, label: "管家", icon: "message-circle", component: StewardScreen },
  { name: ROUTES.records, label: "记录", icon: "clipboard-list", component: RecordsScreen },
  { name: ROUTES.growth, label: "成长", icon: "chart-line", component: GrowthScreen },
  { name: ROUTES.album, label: "相册", icon: "images", component: AlbumScreen },
  { name: ROUTES.me, label: "我的", icon: "circle-user-round", component: MeScreen },
];

export function getTabBarMetrics(fontScale: number, bottomInset: number) {
  const effectiveScale = Math.max(1, fontScale);
  const scaleDelta = effectiveScale - 1;
  return {
    height: Math.max(64, 49 + bottomInset) + Math.ceil(20 * scaleDelta),
    itemPaddingVertical: Math.ceil(4 * scaleDelta),
  } as const;
}

export function RootNavigator({ bootstrap }: { bootstrap: Bootstrap }) {
  const { fontScale } = useWindowDimensions();
  const { bottom } = useSafeAreaInsets();
  const tabMetrics = getTabBarMetrics(fontScale, bottom);

  const navigation = (
    <NavigationContainer theme={navigationTheme}>
      <Tab.Navigator
        initialRouteName={ROUTES.steward}
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.brand,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarActiveBackgroundColor: colors.brandSoft,
          tabBarAllowFontScaling: true,
          tabBarHideOnKeyboard: true,
          tabBarItemStyle: { flex: 1, minHeight: 44, paddingVertical: tabMetrics.itemPaddingVertical },
          tabBarLabelStyle: { fontSize: 12, fontWeight: "600" },
          tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: tabMetrics.height },
        }}
      >
        {tabs.map(({ name, label, icon, component }) => (
          <Tab.Screen
            component={component}
            key={name}
            name={name}
            options={{
              tabBarAccessibilityLabel: label,
              tabBarIcon: ({ color, size }) => <Lucide color={color} name={icon} size={size} />,
              tabBarLabel: label,
              tabBarButtonTestID: `tab-${name}`,
              title: label,
            }}
          />
        ))}
      </Tab.Navigator>
    </NavigationContainer>
  );

  return <BootstrapHost bootstrap={bootstrap}>{navigation}</BootstrapHost>;
}
